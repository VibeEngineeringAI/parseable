// SPDX-License-Identifier: AGPL-3.0-or-later

use super::*;

fn series(metric: &str, attributes: &[(&str, &str)], samples: &[(i64, f64)]) -> Series {
    let mut labels: Labels = attributes
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    labels.insert("__name__".into(), metric.into());
    Series {
        labels,
        samples: samples
            .iter()
            .map(|(timestamp_ms, value)| Sample {
                timestamp_ms: *timestamp_ms,
                value: *value,
            })
            .collect(),
    }
}

fn instant(query: &str, data: &[Series], timestamp_ms: i64) -> QueryValue {
    evaluate(&QueryPlan::parse(query).unwrap(), data, timestamp_ms).unwrap()
}

fn point(query: &str, data: &[Series], timestamp_ms: i64) -> InstantSample {
    let QueryValue::Vector(mut points) = instant(query, data, timestamp_ms) else {
        panic!("expected instant vector")
    };
    assert_eq!(points.len(), 1);
    points.remove(0)
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-10,
        "actual {actual}, expected {expected}"
    );
}

#[test]
fn selectors_use_left_open_right_closed_windows() {
    let data = vec![series(
        "requests_total",
        &[],
        &[(0, 10.0), (60_000, 20.0), (120_000, 30.0)],
    )];
    let QueryValue::Matrix(matrix) = instant("requests_total[2m]", &data, 120_000) else {
        panic!("matrix")
    };
    assert_eq!(
        matrix[0]
            .samples
            .iter()
            .map(|s| s.timestamp_ms)
            .collect::<Vec<_>>(),
        [60_000, 120_000]
    );
    assert_eq!(
        point("requests_total", &data, 120_000).sample,
        Sample {
            timestamp_ms: 120_000,
            value: 30.0
        }
    );
    assert_eq!(
        instant("requests_total", &data, 420_000),
        QueryValue::Vector(Vec::new())
    );
    assert_eq!(point("requests_total", &data, 419_999).sample.value, 30.0);
}

#[test]
fn regex_is_anchored_dotall_and_missing_labels_are_empty() {
    let data = vec![
        series("cpu", &[("job", "api")], &[(1000, 1.0)]),
        series("cpu", &[("job", "api-worker")], &[(1000, 2.0)]),
        series(
            "cpu",
            &[("job", "line\nbreak"), ("zone", "us")],
            &[(1000, 3.0)],
        ),
    ];
    assert_eq!(point("cpu{job=~\"api\"}", &data, 1000).sample.value, 1.0);
    assert_eq!(
        point("cpu{job=~\"line.break\"}", &data, 1000).sample.value,
        3.0
    );
    let QueryValue::Vector(points) = instant("cpu{zone=\"\"}", &data, 1000) else {
        panic!("vector")
    };
    assert_eq!(points.len(), 2);
    assert_eq!(point("cpu{job!~\"api.*\"}", &data, 1000).sample.value, 3.0);
}

#[test]
fn regex_digit_class_uses_re2_ascii_semantics() {
    let data = vec![
        series("m", &[("code", "123")], &[(0, 1.0)]),
        series("m", &[("code", "١٢٣")], &[(0, 2.0)]),
    ];
    assert_eq!(point(r#"m{code=~"\\d+"}"#, &data, 0).sample.value, 1.0);
    assert_eq!(point(r#"m{code=~"[\\D]+"}"#, &data, 0).sample.value, 2.0);
}

#[test]
fn repeated_selector_matcher_operators_stay_distinct() {
    let data = vec![
        series("m", &[("job", "a")], &[(0, 2.0)]),
        series("m", &[("job", "b")], &[(0, 7.0)]),
    ];
    let QueryValue::Scalar(sample) =
        instant("scalar(m{job=\"a\"}) + scalar(m{job!=\"a\"})", &data, 0)
    else {
        panic!("scalar")
    };
    assert_eq!(sample.value, 9.0);
}

#[test]
fn regex_word_boundaries_are_ascii_and_non_re2_features_are_rejected() {
    let data = vec![
        series("m", &[("word", "abc")], &[(0, 1.0)]),
        series("m", &[("word", "éabc")], &[(0, 2.0)]),
    ];
    assert_eq!(point(r#"m{word=~".\\babc"}"#, &data, 0).sample.value, 2.0);
    for query in [r#"m{word=~"[a&&b]"}"#, r#"m{word=~"(?x)a b"}"#] {
        assert!(matches!(
            QueryPlan::parse(query),
            Err(PromqlError::Unsupported(_))
        ));
    }
}

#[test]
fn counter_rate_corrects_resets_and_extrapolates() {
    let data = vec![series(
        "requests_total",
        &[("job", "api")],
        &[
            (60_000, 10.0),
            (120_000, 20.0),
            (180_000, 5.0),
            (240_000, 15.0),
            (300_000, 25.0),
        ],
    )];
    // Observed increase is (25-10)+20=35 over 240s. The zero point is
    // 240*10/35=68.57s before the first sample, beyond the left 60s gap.
    // Full extrapolation yields 35*300/240=43.75, verified with promtool.yml.
    near(
        point("increase(requests_total[5m])", &data, 300_000)
            .sample
            .value,
        43.75,
    );
    near(
        point("rate(requests_total[5m])", &data, 300_000)
            .sample
            .value,
        43.75 / 300.0,
    );
    near(
        point("irate(requests_total[5m])", &data, 300_000)
            .sample
            .value,
        1.0 / 6.0,
    );
    assert_eq!(
        point("resets(requests_total[5m])", &data, 300_000)
            .sample
            .value,
        1.0
    );
    near(
        point("delta(requests_total[5m])", &data, 300_000)
            .sample
            .value,
        18.75,
    );
    let QueryValue::Vector(points) = instant("rate(requests_total[30s])", &data, 300_000) else {
        panic!("vector")
    };
    assert!(points.is_empty());
}

#[test]
fn counter_extrapolation_clips_at_zero_and_large_gaps() {
    let data = vec![series("counter", &[], &[(60_000, 0.0), (120_000, 10.0)])];
    near(
        point("increase(counter[2m])", &data, 120_000).sample.value,
        10.0,
    );
    let data = vec![series(
        "counter",
        &[],
        &[(180_000, 100.0), (240_000, 110.0)],
    )];
    // Start gap exceeds 1.1*spacing, so extrapolate only half a sample interval.
    near(
        point("increase(counter[5m])", &data, 300_000).sample.value,
        25.0,
    );
}

#[test]
fn aggregations_and_binary_matching_preserve_prometheus_labels() {
    let data = vec![
        series(
            "requests_total",
            &[("job", "api"), ("instance", "one")],
            &[(0, 10.0)],
        ),
        series(
            "requests_total",
            &[("job", "api"), ("instance", "two")],
            &[(0, 20.0)],
        ),
        series(
            "limits",
            &[("job", "api"), ("instance", "one")],
            &[(0, 5.0)],
        ),
    ];
    let sum = point("sum by (job) (requests_total)", &data, 0);
    assert_eq!(sum.labels, BTreeMap::from([("job".into(), "api".into())]));
    assert_eq!(sum.sample.value, 30.0);
    assert_eq!(
        point("sum without (instance) (requests_total)", &data, 0).labels,
        sum.labels
    );
    let ratio = point("requests_total / limits", &data, 0);
    assert_eq!(ratio.sample.value, 2.0);
    assert!(!ratio.labels.contains_key("__name__"));
    let comparison = point("requests_total > ignoring (nonexistent) limits", &data, 0);
    assert_eq!(comparison.labels["__name__"], "requests_total");
    assert_eq!(comparison.sample.value, 10.0);
    let matched = point(
        "requests_total{instance=\"one\"} + on (job) limits",
        &data,
        0,
    );
    assert_eq!(matched.labels, sum.labels);
    assert_eq!(matched.sample.value, 15.0);
}

#[test]
fn scalar_vector_comparison_filters_vector_values_and_bool_returns_zero_one() {
    let data = vec![
        series("cpu", &[("instance", "one")], &[(0, 3.0)]),
        series("cpu", &[("instance", "two")], &[(0, 8.0)]),
    ];
    let filtered = point("5 < cpu", &data, 0);
    assert_eq!(filtered.sample.value, 8.0);
    assert_eq!(filtered.labels["__name__"], "cpu");
    let QueryValue::Vector(points) = instant("cpu > bool 5", &data, 0) else {
        panic!("vector")
    };
    assert_eq!(
        points.iter().map(|p| p.sample.value).collect::<Vec<_>>(),
        [0.0, 1.0]
    );
    assert!(points.iter().all(|p| !p.labels.contains_key("__name__")));
}

#[test]
fn timestamp_uses_source_time_for_selectors_and_evaluation_time_for_computations() {
    let data = vec![series("cpu", &[], &[(1000, 2.0)])];
    assert_eq!(point("timestamp(cpu)", &data, 2000).sample.value, 1.0);
    assert_eq!(point("timestamp(cpu + 0)", &data, 2000).sample.value, 2.0);
    assert_eq!(point("timestamp(-cpu)", &data, 2000).sample.value, 2.0);
    assert_eq!(
        point("last_over_time(cpu[1m])", &data, 2000).labels["__name__"],
        "cpu"
    );
}

#[test]
fn range_queries_evaluate_inclusive_steps_and_emit_matrix() {
    let plan = QueryPlan::parse("time()").unwrap();
    let QueryValue::Matrix(matrix) = evaluate_range(&plan, &[], 1000, 3000, 1000).unwrap() else {
        panic!("matrix")
    };
    assert_eq!(matrix.len(), 1);
    assert_eq!(
        matrix[0].samples,
        vec![
            Sample {
                timestamp_ms: 1000,
                value: 1.0
            },
            Sample {
                timestamp_ms: 2000,
                value: 2.0
            },
            Sample {
                timestamp_ms: 3000,
                value: 3.0
            }
        ]
    );
    assert!(evaluate_range(&QueryPlan::parse("cpu[1m]").unwrap(), &[], 0, 1000, 1000).is_err());
}

#[test]
fn promql_json_uses_string_values_and_unix_seconds() {
    assert_eq!(
        instant("1 / 0", &[], 1500).into_json(),
        json!({"resultType":"scalar", "result":[1.5,"+Inf"]})
    );
    assert_eq!(
        instant("0 / 0", &[], 1500).into_json(),
        json!({"resultType":"scalar", "result":[1.5,"NaN"]})
    );
    assert_eq!(point("vector(-1)", &[], 1500).sample.value, -1.0);
}

#[test]
fn stale_markers_remove_instant_series_and_are_ignored_in_ranges() {
    let data = vec![series(
        "cpu",
        &[],
        &[(0, 1.0), (1000, f64::from_bits(STALE_NAN_BITS))],
    )];
    assert_eq!(instant("cpu", &data, 1000), QueryValue::Vector(vec![]));
    assert_eq!(
        point("count_over_time(cpu[1m])", &data, 1000).sample.value,
        1.0
    );
}

#[test]
fn unsupported_features_and_invalid_inputs_fail_explicitly() {
    for query in [
        "cpu offset 5m",
        "cpu @ 100",
        "rate(cpu[5m:1m])",
        "topk(2, cpu)",
        "histogram_quantile(0.9, cpu)",
        "cpu or other",
        "cpu * on (job) group_left other",
    ] {
        assert!(
            matches!(QueryPlan::parse(query), Err(PromqlError::Unsupported(_))),
            "query {query}"
        );
    }
    let data = vec![series("cpu", &[], &[(1000, 1.0), (1000, 2.0)])];
    assert!(matches!(
        evaluate(&QueryPlan::parse("cpu").unwrap(), &data, 1000),
        Err(PromqlError::Evaluation(_))
    ));
    let data = vec![
        series("cpu", &[("instance", "one")], &[(0, 1.0)]),
        series("cpu", &[("instance", "two")], &[(0, 2.0)]),
        series("other", &[], &[(0, 3.0)]),
    ];
    assert!(matches!(
        evaluate(&QueryPlan::parse("cpu + on () other").unwrap(), &data, 0),
        Err(PromqlError::Evaluation(_))
    ));
}

#[test]
fn query_bounds_apply_before_evaluation() {
    assert!(matches!(
        QueryPlan::parse(&"a".repeat(MAX_QUERY_BYTES + 1)),
        Err(PromqlError::Limit(_))
    ));
    assert!(matches!(
        QueryPlan::parse(&format!("{}cpu{}", "(".repeat(65), ")".repeat(65))),
        Err(PromqlError::Limit(_))
    ));
    let plan = QueryPlan::parse("time()").unwrap();
    assert!(matches!(
        evaluate_range(&plan, &[], 0, 11_000, 1),
        Err(PromqlError::Limit(_))
    ));
    assert!(matches!(
        evaluate_range(&plan, &[], 0, i64::MAX, 1),
        Err(PromqlError::Limit(_))
    ));
    assert!(evaluate_range(&plan, &[], 0, 1000, 0).is_err());
    assert_eq!(
        QueryPlan::parse("rate(cpu[30m])")
            .unwrap()
            .required_history_ms(),
        1_800_000
    );
}

#[test]
fn aggregations_compensate_cancellation_and_avoid_mean_overflow() {
    let data = vec![
        series("m", &[("id", "a")], &[(0, 1e16)]),
        series("m", &[("id", "b")], &[(0, 1.0)]),
        series("m", &[("id", "c")], &[(0, -1e16)]),
    ];
    assert_eq!(point("sum(m)", &data, 0).sample.value, 1.0);
    near(point("avg(m)", &data, 0).sample.value, 1.0 / 3.0);
    let data = vec![
        series("m", &[("id", "a")], &[(0, 1e308)]),
        series("m", &[("id", "b")], &[(0, 1e308)]),
    ];
    assert_eq!(point("avg(m)", &data, 0).sample.value, 1e308);
    assert_eq!(point("stdvar(m)", &data, 0).sample.value, 0.0);
    assert_eq!(point("stddev(m)", &data, 0).sample.value, 0.0);
    let data = vec![series("m", &[], &[(0, 1e16), (1000, 1.0), (2000, -1e16)])];
    assert_eq!(point("sum_over_time(m[1m])", &data, 2000).sample.value, 1.0);
    near(
        point("avg_over_time(m[1m])", &data, 2000).sample.value,
        1.0 / 3.0,
    );
    let data = vec![series("m", &[], &[(0, 1e308), (1000, 1e308)])];
    assert_eq!(
        point("avg_over_time(m[1m])", &data, 1000).sample.value,
        1e308
    );
    assert_eq!(aggregate("sum", &[f64::INFINITY, 1.0]), f64::INFINITY);
    assert_eq!(aggregate("avg", &[f64::INFINITY, 1.0]), f64::INFINITY);
    assert!(aggregate("avg", &[f64::INFINITY, f64::NEG_INFINITY]).is_nan());
    assert!(aggregate("stdvar", &[f64::INFINITY]).is_nan());
    near(
        aggregate("stdvar", &[1e12, 1e12 + 1.0, 1e12 + 2.0]),
        2.0 / 3.0,
    );
}

#[test]
fn work_budget_counts_label_bytes_before_regex_matching_and_cloning() {
    let mut data = series("m", &[], &[(0, 1.0)]);
    data.labels
        .insert("payload".into(), "x".repeat(MAX_WORK + 1));
    for query in ["m", "m{payload=~\".*\"}"] {
        assert!(matches!(
            evaluate(
                &QueryPlan::parse(query).unwrap(),
                std::slice::from_ref(&data),
                0
            ),
            Err(PromqlError::Limit(_))
        ));
    }
}
