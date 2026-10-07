// SPDX-License-Identifier: AGPL-3.0-or-later

//! A bounded, float-sample PromQL evaluator for community metric streams.
//!
//! Parsing uses the independent `promql-parser` crate. Unsupported language
//! features are rejected during planning, before any storage query is issued.
//! All timestamps at this boundary are Unix milliseconds. Callers must load
//! `required_history_ms()` before the first evaluation instant.

use std::collections::{BTreeMap, BTreeSet};

use promql_parser::{
    label::{MatchOp, Matcher},
    parser::{self, Expr, LabelModifier, VectorMatchCardinality, VectorSelector},
};
use serde_json::{Value, json};
use thiserror::Error;

pub const DEFAULT_LOOKBACK_MS: i64 = 300_000;
pub const MAX_INPUT_SAMPLES: usize = 250_000;
pub const MAX_SERIES: usize = 10_000;
pub const MAX_STEPS: usize = 11_000;
pub const MAX_OUTPUT_SAMPLES: usize = 250_000;
const MAX_WORK: usize = 20_000_000;
const MAX_QUERY_BYTES: usize = 4096;
const MAX_DEPTH: usize = 64;
const MAX_NODES: usize = 256;
// Prometheus's stale NaN is distinct from an ordinary NaN sample.
const STALE_NAN_BITS: u64 = 0x7ff0000000000002;

pub type Labels = BTreeMap<String, String>;

#[derive(Clone, Debug, PartialEq)]
pub struct Sample {
    pub timestamp_ms: i64,
    pub value: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Series {
    pub labels: Labels,
    pub samples: Vec<Sample>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct InstantSample {
    pub labels: Labels,
    pub sample: Sample,
}

#[derive(Clone, Debug)]
pub struct Selector {
    pub metric: Option<String>,
    pub matchers: Vec<Matcher>,
}

impl Selector {
    pub fn matches(&self, labels: &Labels) -> bool {
        self.metric
            .as_ref()
            .is_none_or(|metric| labels.get("__name__").is_some_and(|name| name == metric))
            && self.matchers.iter().all(|matcher| {
                matcher.is_match(labels.get(&matcher.name).map_or("", String::as_str))
            })
    }
}

#[derive(Debug, Error)]
pub enum PromqlError {
    #[error("invalid PromQL: {0}")]
    Invalid(String),
    #[error("unsupported PromQL feature: {0}")]
    Unsupported(String),
    #[error("PromQL query limit exceeded: {0}")]
    Limit(String),
    #[error("PromQL evaluation failed: {0}")]
    Evaluation(String),
}

#[derive(Debug)]
pub struct QueryPlan {
    expr: Expr,
    selectors: Vec<Selector>,
    history_ms: i64,
}

impl QueryPlan {
    pub fn parse(query: &str) -> Result<Self, PromqlError> {
        if query.is_empty() {
            return Err(PromqlError::Invalid("query must not be empty".into()));
        }
        if query.len() > MAX_QUERY_BYTES {
            return Err(limit("query exceeds 4096 bytes"));
        }
        // Protect the parser itself from deeply nested untrusted expressions.
        let mut depth = 0usize;
        let mut quote = None;
        let mut escaped = false;
        let mut comment = false;
        for c in query.chars() {
            if comment {
                if c == '\n' {
                    comment = false;
                }
                continue;
            }
            if let Some(q) = quote {
                if escaped {
                    escaped = false;
                } else if c == '\\' && q != '`' {
                    escaped = true;
                } else if c == q {
                    quote = None;
                }
                continue;
            }
            match c {
                '#' => comment = true,
                '"' | '\'' | '`' => quote = Some(c),
                '(' | '[' | '{' => {
                    depth += 1;
                    if depth > MAX_DEPTH {
                        return Err(limit("expression nesting exceeds 64"));
                    }
                }
                ')' | ']' | '}' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
        let expr = parser::parse(query).map_err(PromqlError::Invalid)?;
        let mut plan = Self {
            expr,
            selectors: Vec::new(),
            history_ms: DEFAULT_LOOKBACK_MS,
        };
        let mut count = 0;
        validate_expr(
            &plan.expr,
            &mut plan.selectors,
            &mut plan.history_ms,
            0,
            &mut count,
        )?;
        Ok(plan)
    }

    pub fn is_instant_vector(&self) -> bool {
        self.expr.value_type() == promql_parser::parser::value::ValueType::Vector
    }

    pub fn selectors(&self) -> &[Selector] {
        &self.selectors
    }

    pub fn required_history_ms(&self) -> i64 {
        self.history_ms
    }
}

fn limit(message: &str) -> PromqlError {
    PromqlError::Limit(message.into())
}
fn unsupported(message: impl Into<String>) -> PromqlError {
    PromqlError::Unsupported(message.into())
}
fn evaluation(message: &str) -> PromqlError {
    PromqlError::Evaluation(message.into())
}

fn validate_selector(
    vs: &VectorSelector,
    selectors: &mut Vec<Selector>,
) -> Result<(), PromqlError> {
    if vs.offset.is_some() {
        return Err(unsupported("offset modifiers"));
    }
    if vs.at.is_some() {
        return Err(unsupported("@ modifiers"));
    }
    if !vs.matchers.or_matchers.is_empty() {
        return Err(unsupported("OR label matchers"));
    }
    let mut matchers = vs.matchers.matchers.clone();
    // Prometheus regex matching enables dot-newline and disables Unicode character
    // classes (Go's RE2 uses ASCII \d/\w/\s). Compile explicitly with these flags.
    for matcher in &mut matchers {
        let negative = matches!(matcher.op, MatchOp::NotRe(_));
        if matches!(matcher.op, MatchOp::Re(_) | MatchOp::NotRe(_)) {
            validate_regex_subset(&matcher.value)?;
            let regex =
                regex::RegexBuilder::new(&format!("^(?:{})$", re2_ascii_classes(&matcher.value)))
                    .dot_matches_new_line(true)
                    .build()
                    .map_err(|e| unsupported(format!("label regex: {e}")))?;
            matcher.op = if negative {
                MatchOp::NotRe(regex)
            } else {
                MatchOp::Re(regex)
            };
        }
    }
    selectors.push(Selector {
        metric: vs.name.clone(),
        matchers,
    });
    Ok(())
}

fn re2_ascii_classes(pattern: &str) -> String {
    let mut output = String::new();
    let mut chars = pattern.chars();
    let mut in_class = false;
    while let Some(c) = chars.next() {
        if c != '\\' {
            if c == '[' {
                in_class = true;
            }
            if c == ']' {
                in_class = false;
            }
            output.push(c);
            continue;
        }
        match chars.next() {
            Some('d') => output.push_str("[0-9]"),
            Some('D') => output.push_str("[^0-9]"),
            Some('w') => output.push_str("[A-Za-z0-9_]"),
            Some('W') => output.push_str("[^A-Za-z0-9_]"),
            Some('s') => output.push_str("[\\t\\n\\f\\r ]"),
            Some('S') => output.push_str("[^\\t\\n\\f\\r ]"),
            Some('b') if !in_class => output.push_str("(?-u:\\b)"),
            Some('B') if !in_class => output.push_str("(?-u:\\B)"),
            Some(next) => {
                output.push('\\');
                output.push(next);
            }
            None => output.push('\\'),
        }
    }
    output
}

fn validate_regex_subset(pattern: &str) -> Result<(), PromqlError> {
    // Rust regex accepts character-class set operations and flags that RE2
    // treats differently. Reject these instead of returning different matches.
    let mut in_class = false;
    let mut escaped = false;
    let chars: Vec<_> = pattern.chars().collect();
    for (index, &c) in chars.iter().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if c == '\\' {
            escaped = true;
            continue;
        }
        if c == '[' {
            in_class = true;
        }
        if c == ']' {
            in_class = false;
        }
        if in_class && matches!(c, '&' | '-' | '~') && chars.get(index + 1) == Some(&c) {
            return Err(unsupported("label regex character-class set operations"));
        }
        if !in_class && c == '(' && chars.get(index + 1) == Some(&'?') {
            for &flag in chars.iter().skip(index + 2) {
                if flag == ':' || flag == ')' {
                    break;
                }
                if matches!(flag, 'P' | '<' | '=' | '!') {
                    break;
                }
                if !matches!(flag, 'i' | 'm' | 's' | 'U' | '-') {
                    return Err(unsupported("label regex flag outside the RE2 subset"));
                }
            }
        }
    }
    Ok(())
}

fn validate_expr(
    expr: &Expr,
    selectors: &mut Vec<Selector>,
    history: &mut i64,
    depth: usize,
    count: &mut usize,
) -> Result<(), PromqlError> {
    *count += 1;
    if depth > MAX_DEPTH || *count > MAX_NODES {
        return Err(limit("expression is too complex"));
    }
    let mut child = |expr: &Expr| validate_expr(expr, selectors, history, depth + 1, count);
    match expr {
        Expr::NumberLiteral(_) => Ok(()),
        Expr::VectorSelector(vs) => validate_selector(vs, selectors),
        Expr::MatrixSelector(ms) => {
            let range = i64::try_from(ms.range.as_millis())
                .map_err(|_| limit("range duration overflows milliseconds"))?;
            if range <= 0 {
                return Err(PromqlError::Invalid(
                    "range duration must be at least 1ms".into(),
                ));
            }
            *history = (*history).max(range);
            validate_selector(&ms.vs, selectors)
        }
        Expr::Paren(expr) => child(&expr.expr),
        Expr::Unary(expr) => child(&expr.expr),
        Expr::Aggregate(expr) => {
            if !matches!(
                expr.op.to_string().as_str(),
                "sum" | "avg" | "count" | "min" | "max" | "group" | "stddev" | "stdvar"
            ) {
                return Err(unsupported(format!("aggregation {}", expr.op)));
            }
            child(&expr.expr)
        }
        Expr::Binary(expr) => {
            if !matches!(
                expr.op.to_string().as_str(),
                "+" | "-" | "*" | "/" | "%" | "^" | "atan2" | "==" | "!=" | ">" | "<" | ">=" | "<="
            ) {
                return Err(unsupported(format!("binary operator {}", expr.op)));
            }
            if let Some(modifier) = &expr.modifier {
                if !matches!(modifier.card, VectorMatchCardinality::OneToOne) {
                    return Err(unsupported("group_left/group_right vector matching"));
                }
                if modifier.fill_values.lhs.is_some() || modifier.fill_values.rhs.is_some() {
                    return Err(unsupported("vector matching fill values"));
                }
            }
            child(&expr.lhs)?;
            child(&expr.rhs)
        }
        Expr::Call(call) => {
            let name = call.func.name;
            if !matches!(
                name,
                "rate"
                    | "increase"
                    | "delta"
                    | "irate"
                    | "idelta"
                    | "sum_over_time"
                    | "avg_over_time"
                    | "count_over_time"
                    | "min_over_time"
                    | "max_over_time"
                    | "last_over_time"
                    | "present_over_time"
                    | "changes"
                    | "resets"
                    | "abs"
                    | "ceil"
                    | "floor"
                    | "sqrt"
                    | "exp"
                    | "ln"
                    | "log2"
                    | "log10"
                    | "timestamp"
                    | "scalar"
                    | "vector"
                    | "time"
            ) {
                return Err(unsupported(format!("function {name}")));
            }
            for arg in &call.args.args {
                child(arg)?;
            }
            Ok(())
        }
        Expr::Subquery(_) => Err(unsupported("subqueries")),
        Expr::StringLiteral(_) => Err(unsupported("string expressions")),
        Expr::Extension(_) => Err(unsupported("extension expressions")),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum QueryValue {
    Scalar(Sample),
    Vector(Vec<InstantSample>),
    Matrix(Vec<Series>),
}

impl QueryValue {
    /// Prometheus's `data` object. Values are strings, including NaN and infinities.
    pub fn into_json(self) -> Value {
        match self {
            Self::Scalar(sample) => json!({"resultType": "scalar", "result": sample_json(&sample)}),
            Self::Vector(samples) => {
                json!({"resultType": "vector", "result": samples.into_iter().map(|point| json!({"metric": point.labels, "value": sample_json(&point.sample)})).collect::<Vec<_>>()})
            }
            Self::Matrix(series) => {
                json!({"resultType": "matrix", "result": series.into_iter().map(|series| json!({"metric": series.labels, "values": series.samples.iter().map(sample_json).collect::<Vec<_>>()})).collect::<Vec<_>>()})
            }
        }
    }
}

fn sample_json(sample: &Sample) -> Value {
    let value = if sample.value.is_nan() {
        "NaN".into()
    } else if sample.value == f64::INFINITY {
        "+Inf".into()
    } else if sample.value == f64::NEG_INFINITY {
        "-Inf".into()
    } else {
        sample.value.to_string()
    };
    json!([sample.timestamp_ms as f64 / 1000.0, value])
}

fn validate_series(series: &[Series]) -> Result<(), PromqlError> {
    if series.len() > MAX_SERIES {
        return Err(limit("more than 10000 input series"));
    }
    let mut count = 0usize;
    let mut labels = BTreeSet::new();
    for series in series {
        count = count
            .checked_add(series.samples.len())
            .ok_or_else(|| limit("input samples overflow"))?;
        if count > MAX_INPUT_SAMPLES {
            return Err(limit("more than 250000 input samples"));
        }
        if !labels.insert(&series.labels) {
            return Err(evaluation("duplicate input label sets"));
        }
        if series
            .samples
            .windows(2)
            .any(|pair| pair[0].timestamp_ms >= pair[1].timestamp_ms)
        {
            return Err(evaluation(
                "input sample timestamps must be strictly increasing",
            ));
        }
    }
    Ok(())
}

pub fn evaluate(
    plan: &QueryPlan,
    series: &[Series],
    timestamp_ms: i64,
) -> Result<QueryValue, PromqlError> {
    validate_series(series)?;
    let mut context = Context {
        series,
        plan,
        timestamp_ms,
        label_work: input_label_work(series),
        work: 0,
    };
    let value = context.eval(&plan.expr)?;
    context.finish(value)
}

pub fn evaluate_range(
    plan: &QueryPlan,
    series: &[Series],
    start_ms: i64,
    end_ms: i64,
    step_ms: i64,
) -> Result<QueryValue, PromqlError> {
    if step_ms <= 0 || end_ms < start_ms {
        return Err(PromqlError::Invalid(
            "step must be positive and end must not precede start".into(),
        ));
    }
    let span = end_ms
        .checked_sub(start_ms)
        .ok_or_else(|| limit("query time span overflows"))?;
    let steps = (span / step_ms)
        .checked_add(1)
        .ok_or_else(|| limit("evaluation step count overflows"))?;
    if steps > MAX_STEPS as i64 {
        return Err(limit("more than 11000 evaluation steps"));
    }
    if matches!(
        plan.expr.value_type(),
        promql_parser::parser::value::ValueType::Matrix
    ) {
        return Err(PromqlError::Invalid(
            "range queries require a scalar or instant-vector expression".into(),
        ));
    }
    validate_series(series)?;
    let mut context = Context {
        series,
        plan,
        timestamp_ms: start_ms,
        label_work: input_label_work(series),
        work: 0,
    };
    let mut matrix: BTreeMap<Labels, Vec<Sample>> = BTreeMap::new();
    let mut output_samples = 0;
    for index in 0..steps {
        context.timestamp_ms = start_ms + index * step_ms;
        let value = context.eval(&plan.expr)?;
        let points = match context.finish(value)? {
            QueryValue::Scalar(sample) => vec![InstantSample {
                labels: Labels::new(),
                sample,
            }],
            QueryValue::Vector(points) => points,
            QueryValue::Matrix(_) => return Err(evaluation("matrix in range query")),
        };
        output_samples += points.len();
        if output_samples > MAX_OUTPUT_SAMPLES {
            return Err(limit("more than 250000 output samples"));
        }
        for point in points {
            matrix.entry(point.labels).or_default().push(point.sample);
        }
        if matrix.len() > MAX_SERIES {
            return Err(limit("more than 10000 output series"));
        }
    }
    Ok(QueryValue::Matrix(
        matrix
            .into_iter()
            .map(|(labels, samples)| Series { labels, samples })
            .collect(),
    ))
}

enum EvalValue {
    Scalar(f64),
    Vector(Vec<InstantSample>),
    Matrix(Vec<Series>),
}

struct Context<'a> {
    series: &'a [Series],
    plan: &'a QueryPlan,
    timestamp_ms: i64,
    label_work: usize,
    work: usize,
}

fn input_label_work(series: &[Series]) -> usize {
    series.iter().fold(series.len(), |total, series| {
        series.labels.iter().fold(total, |cost, (name, value)| {
            cost.saturating_add(name.len())
                .saturating_add(value.len())
                .saturating_add(16)
        })
    })
}

impl Context<'_> {
    fn charge(&mut self, amount: usize) -> Result<(), PromqlError> {
        self.work = self.work.saturating_add(amount);
        if self.work > MAX_WORK {
            return Err(limit(
                "evaluation work exceeds 20000000 units; use a shorter range or larger step",
            ));
        }
        Ok(())
    }

    fn finish(&self, value: EvalValue) -> Result<QueryValue, PromqlError> {
        match value {
            EvalValue::Scalar(value) => Ok(QueryValue::Scalar(Sample {
                timestamp_ms: self.timestamp_ms,
                value,
            })),
            EvalValue::Vector(mut points) => {
                unique_points(&points)?;
                for point in &mut points {
                    point.sample.timestamp_ms = self.timestamp_ms;
                }
                Ok(QueryValue::Vector(points))
            }
            EvalValue::Matrix(series) => Ok(QueryValue::Matrix(series)),
        }
    }

    fn selector(&self, vs: &VectorSelector) -> &Selector {
        // Plans were validated, and each selector was collected during planning.
        self.plan
            .selectors
            .iter()
            .find(|selector| {
                selector.metric == vs.name
                    && selector
                        .matchers
                        .iter()
                        .map(|m| (&m.name, &m.value, m.op.to_string()))
                        .eq(vs
                            .matchers
                            .matchers
                            .iter()
                            .map(|m| (&m.name, &m.value, m.op.to_string())))
            })
            .expect("validated selector")
    }

    fn select(
        &mut self,
        vs: &VectorSelector,
        range: Option<i64>,
    ) -> Result<EvalValue, PromqlError> {
        self.charge(self.plan.selectors.len())?;
        let selector = self.selector(vs).clone();
        // Count string scanning and cloning, not just series cardinality. A
        // large label must not be copied or regex-scanned at every step while
        // consuming only a single work unit. The extra pass covers cloning.
        self.charge(
            self.label_work
                .saturating_mul(vs.matchers.matchers.len() + 1),
        )?;
        let start = self
            .timestamp_ms
            .checked_sub(range.unwrap_or(DEFAULT_LOOKBACK_MS))
            .ok_or_else(|| limit("lookback timestamp overflows"))?;
        let mut points = Vec::new();
        let mut matrix = Vec::new();
        for series in self.series {
            if !selector.matches(&series.labels) {
                continue;
            }
            let end_index = series
                .samples
                .partition_point(|sample| sample.timestamp_ms <= self.timestamp_ms);
            if range.is_some() {
                let start_index = series.samples[..end_index]
                    .partition_point(|sample| sample.timestamp_ms <= start);
                self.charge(end_index - start_index)?;
                let samples: Vec<_> = series.samples[start_index..end_index]
                    .iter()
                    .filter(|sample| sample.value.to_bits() != STALE_NAN_BITS)
                    .cloned()
                    .collect();
                if !samples.is_empty() {
                    matrix.push(Series {
                        labels: series.labels.clone(),
                        samples,
                    });
                }
            } else if let Some(sample) = end_index
                .checked_sub(1)
                .and_then(|index| series.samples.get(index))
                && sample.timestamp_ms > start
                && sample.value.to_bits() != STALE_NAN_BITS
            {
                points.push(InstantSample {
                    labels: series.labels.clone(),
                    sample: sample.clone(),
                });
            }
        }
        Ok(if range.is_some() {
            EvalValue::Matrix(matrix)
        } else {
            EvalValue::Vector(points)
        })
    }

    fn eval(&mut self, expr: &Expr) -> Result<EvalValue, PromqlError> {
        self.charge(1)?;
        match expr {
            Expr::NumberLiteral(number) => Ok(EvalValue::Scalar(number.val)),
            Expr::VectorSelector(vs) => self.select(vs, None),
            Expr::MatrixSelector(ms) => self.select(&ms.vs, Some(ms.range.as_millis() as i64)),
            Expr::Paren(expr) => self.eval(&expr.expr),
            Expr::Unary(expr) => match self.eval(&expr.expr)? {
                EvalValue::Scalar(value) => Ok(EvalValue::Scalar(-value)),
                EvalValue::Vector(mut points) => {
                    for point in &mut points {
                        point.sample.value = -point.sample.value;
                        point.sample.timestamp_ms = self.timestamp_ms;
                        point.labels.remove("__name__");
                    }
                    unique_points(&points)?;
                    Ok(EvalValue::Vector(points))
                }
                EvalValue::Matrix(_) => Err(evaluation(
                    "unary operator requires scalar or instant vector",
                )),
            },
            Expr::Aggregate(expr) => {
                let EvalValue::Vector(points) = self.eval(&expr.expr)? else {
                    return Err(evaluation("aggregation requires instant vector"));
                };
                self.charge(points.len())?;
                let mut groups: BTreeMap<Labels, Vec<f64>> = BTreeMap::new();
                for point in points {
                    let labels = grouping_labels(&point.labels, expr.modifier.as_ref(), false);
                    groups.entry(labels).or_default().push(point.sample.value);
                }
                Ok(EvalValue::Vector(
                    groups
                        .into_iter()
                        .map(|(labels, values)| InstantSample {
                            labels,
                            sample: Sample {
                                timestamp_ms: self.timestamp_ms,
                                value: aggregate(&expr.op.to_string(), &values),
                            },
                        })
                        .collect(),
                ))
            }
            Expr::Binary(expr) => {
                let lhs = self.eval(&expr.lhs)?;
                let rhs = self.eval(&expr.rhs)?;
                self.binary(expr, lhs, rhs)
            }
            Expr::Call(call) => self.call(call),
            _ => Err(evaluation("unvalidated expression")),
        }
    }

    fn call(&mut self, call: &parser::Call) -> Result<EvalValue, PromqlError> {
        let name = call.func.name;
        if name == "time" {
            return Ok(EvalValue::Scalar(self.timestamp_ms as f64 / 1000.0));
        }
        let arg = call
            .args
            .args
            .first()
            .ok_or_else(|| evaluation("missing function argument"))?;
        let value = self.eval(arg)?;
        match value {
            EvalValue::Scalar(value) if name == "vector" => {
                Ok(EvalValue::Vector(vec![InstantSample {
                    labels: Labels::new(),
                    sample: Sample {
                        timestamp_ms: self.timestamp_ms,
                        value,
                    },
                }]))
            }
            EvalValue::Vector(points) if name == "scalar" => {
                Ok(EvalValue::Scalar(if points.len() == 1 {
                    points[0].sample.value
                } else {
                    f64::NAN
                }))
            }
            EvalValue::Vector(mut points) => {
                self.charge(points.len())?;
                for point in &mut points {
                    point.sample.value = match name {
                        "timestamp" => point.sample.timestamp_ms as f64 / 1000.0,
                        "abs" => point.sample.value.abs(),
                        "ceil" => point.sample.value.ceil(),
                        "floor" => point.sample.value.floor(),
                        "sqrt" => point.sample.value.sqrt(),
                        "exp" => point.sample.value.exp(),
                        "ln" => point.sample.value.ln(),
                        "log2" => point.sample.value.log2(),
                        "log10" => point.sample.value.log10(),
                        _ => return Err(evaluation("function requires range vector")),
                    };
                    point.labels.remove("__name__");
                    point.sample.timestamp_ms = self.timestamp_ms;
                }
                unique_points(&points)?;
                Ok(EvalValue::Vector(points))
            }
            EvalValue::Matrix(matrix) => {
                let range_ms = matrix_range(arg)
                    .ok_or_else(|| evaluation("function requires a range selector"))?;
                let mut points = Vec::new();
                for series in matrix {
                    self.charge(series.samples.len())?;
                    if let Some(value) =
                        range_function(name, &series.samples, self.timestamp_ms, range_ms)
                    {
                        let mut labels = series.labels;
                        if name != "last_over_time" {
                            labels.remove("__name__");
                        }
                        points.push(InstantSample {
                            labels,
                            sample: Sample {
                                timestamp_ms: self.timestamp_ms,
                                value,
                            },
                        });
                    }
                }
                unique_points(&points)?;
                Ok(EvalValue::Vector(points))
            }
            _ => Err(evaluation("incorrect function argument type")),
        }
    }

    fn binary(
        &mut self,
        expr: &parser::BinaryExpr,
        lhs: EvalValue,
        rhs: EvalValue,
    ) -> Result<EvalValue, PromqlError> {
        let op = expr.op.to_string();
        let return_bool = expr.return_bool();
        let comparison = matches!(op.as_str(), "==" | "!=" | ">" | "<" | ">=" | "<=");
        match (lhs, rhs) {
            (EvalValue::Scalar(lhs), EvalValue::Scalar(rhs)) => Ok(EvalValue::Scalar(
                binary_value(&op, lhs, rhs, true).unwrap_or(f64::NAN),
            )),
            (EvalValue::Vector(points), EvalValue::Scalar(scalar))
            | (EvalValue::Scalar(scalar), EvalValue::Vector(points)) => {
                self.charge(points.len())?;
                let scalar_left = matches!(
                    expr.lhs.value_type(),
                    promql_parser::parser::value::ValueType::Scalar
                );
                let mut result = Vec::new();
                for mut point in points {
                    let (lhs, rhs) = if scalar_left {
                        (scalar, point.sample.value)
                    } else {
                        (point.sample.value, scalar)
                    };
                    if let Some(value) = binary_value(&op, lhs, rhs, return_bool) {
                        if !comparison || return_bool {
                            point.sample.value = value;
                            point.labels.remove("__name__");
                        }
                        point.sample.timestamp_ms = self.timestamp_ms;
                        result.push(point);
                    }
                }
                unique_points(&result)?;
                Ok(EvalValue::Vector(result))
            }
            (EvalValue::Vector(lhs), EvalValue::Vector(rhs)) => {
                self.charge(lhs.len() + rhs.len())?;
                let matching = expr.modifier.as_ref().and_then(|m| m.matching.as_ref());
                let mut right = BTreeMap::new();
                for point in rhs {
                    let key = matching_labels(&point.labels, matching);
                    if right.insert(key, point).is_some() {
                        return Err(evaluation(
                            "many-to-many matching: right side has duplicate matching labels",
                        ));
                    }
                }
                let mut seen = BTreeSet::new();
                let mut result = Vec::new();
                for mut point in lhs {
                    let key = matching_labels(&point.labels, matching);
                    if !seen.insert(key.clone()) {
                        return Err(evaluation(
                            "many-to-many matching: left side has duplicate matching labels",
                        ));
                    }
                    if let Some(right) = right.get(&key)
                        && let Some(value) =
                            binary_value(&op, point.sample.value, right.sample.value, return_bool)
                    {
                        point.sample.value = value;
                        point.labels = grouping_labels(&point.labels, matching, true);
                        if !comparison
                            || return_bool
                            || matching.is_some_and(LabelModifier::is_include)
                        {
                            point.labels.remove("__name__");
                        }
                        point.sample.timestamp_ms = self.timestamp_ms;
                        result.push(point);
                    }
                }
                unique_points(&result)?;
                Ok(EvalValue::Vector(result))
            }
            _ => Err(evaluation(
                "binary operator requires scalars or instant vectors",
            )),
        }
    }
}

fn unique_points(points: &[InstantSample]) -> Result<(), PromqlError> {
    let mut seen = BTreeSet::new();
    for point in points {
        if !seen.insert(&point.labels) {
            return Err(evaluation(
                "vector contains duplicate label sets after metric name removal",
            ));
        }
    }
    Ok(())
}

fn grouping_labels(
    labels: &Labels,
    modifier: Option<&LabelModifier>,
    preserve_default: bool,
) -> Labels {
    match modifier {
        Some(LabelModifier::Include(include)) => labels
            .iter()
            .filter(|(name, _)| include.labels.contains(name))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        Some(LabelModifier::Exclude(exclude)) => labels
            .iter()
            .filter(|(name, _)| {
                (preserve_default || name.as_str() != "__name__") && !exclude.labels.contains(name)
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        None if preserve_default => labels.clone(),
        None => Labels::new(),
    }
}

fn matching_labels(labels: &Labels, modifier: Option<&LabelModifier>) -> Labels {
    let mut labels = grouping_labels(labels, modifier, true);
    if !modifier.is_some_and(LabelModifier::is_include) {
        labels.remove("__name__");
    }
    labels
}

fn aggregate(op: &str, values: &[f64]) -> f64 {
    match op {
        "sum" => compensated_sum(values.iter().copied()),
        "avg" => safe_mean(values.iter().copied()),
        "count" => values.len() as f64,
        "group" => 1.0,
        "min" => values.iter().copied().fold(f64::NAN, f64::min),
        "max" => values.iter().copied().fold(f64::NAN, f64::max),
        "stdvar" | "stddev" => {
            let variance = population_variance(values);
            if op == "stddev" {
                variance.sqrt()
            } else {
                variance
            }
        }
        _ => f64::NAN,
    }
}

/// Neumaier's compensated summation keeps small terms during cancellation.
#[derive(Clone, Copy, Default)]
struct CompensatedSum {
    sum: f64,
    correction: f64,
}

impl CompensatedSum {
    fn add(&mut self, value: f64) {
        let combined = self.sum + value;
        if combined.is_infinite() {
            // An infinite sum needs no finite rounding correction. This also
            // keeps +Inf plus finite samples at +Inf rather than producing NaN.
            self.correction = 0.0;
        } else if self.sum.abs() >= value.abs() {
            self.correction += (self.sum - combined) + value;
        } else {
            self.correction += (value - combined) + self.sum;
        }
        self.sum = combined;
    }

    fn total(self) -> f64 {
        self.sum + self.correction
    }
}

fn compensated_sum(values: impl Iterator<Item = f64>) -> f64 {
    let mut sum = CompensatedSum::default();
    for value in values {
        sum.add(value);
    }
    sum.total()
}

/// Preserve direct compensated averaging until its running sum overflows;
/// then update the mean using weighted terms that individually stay in range.
fn safe_mean(mut values: impl Iterator<Item = f64>) -> f64 {
    let Some(first) = values.next() else {
        return f64::NAN;
    };
    let mut sum = CompensatedSum {
        sum: first,
        correction: 0.0,
    };
    let mut count = 1.0;
    let mut incremental = false;
    for value in values {
        count += 1.0;
        if !incremental {
            let mut candidate = sum;
            candidate.add(value);
            if !candidate.sum.is_infinite() {
                sum = candidate;
                continue;
            }
            incremental = true;
            sum.sum /= count - 1.0;
            sum.correction /= count - 1.0;
        }
        let previous_weight = (count - 1.0) / count;
        sum.sum *= previous_weight;
        sum.correction *= previous_weight;
        sum.add(value / count);
    }
    if incremental {
        sum.total()
    } else {
        sum.sum / count + sum.correction / count
    }
}

/// Welford's population variance avoids constructing a potentially overflowing
/// total merely to calculate the mean, matching Prometheus aggregations.
fn population_variance(values: &[f64]) -> f64 {
    let Some(&first) = values.first() else {
        return f64::NAN;
    };
    if !first.is_finite() {
        return f64::NAN;
    }
    let mut mean = first;
    let mut squared_deviations = 0.0;
    for (index, &value) in values.iter().enumerate().skip(1) {
        let delta = value - mean;
        mean += delta / (index + 1) as f64;
        squared_deviations += delta * (value - mean);
    }
    squared_deviations / values.len() as f64
}

fn binary_value(op: &str, lhs: f64, rhs: f64, return_bool: bool) -> Option<f64> {
    let comparison = match op {
        "+" => return Some(lhs + rhs),
        "-" => return Some(lhs - rhs),
        "*" => return Some(lhs * rhs),
        "/" => return Some(lhs / rhs),
        "%" => return Some(lhs % rhs),
        "^" => return Some(lhs.powf(rhs)),
        "atan2" => return Some(lhs.atan2(rhs)),
        "==" => lhs == rhs,
        "!=" => lhs != rhs,
        ">" => lhs > rhs,
        "<" => lhs < rhs,
        ">=" => lhs >= rhs,
        "<=" => lhs <= rhs,
        _ => return None,
    };
    if return_bool {
        Some(if comparison { 1.0 } else { 0.0 })
    } else if comparison {
        Some(lhs)
    } else {
        None
    }
}

fn matrix_range(expr: &Expr) -> Option<i64> {
    match expr {
        Expr::MatrixSelector(ms) => Some(ms.range.as_millis() as i64),
        Expr::Paren(expr) => matrix_range(&expr.expr),
        _ => None,
    }
}

fn range_function(name: &str, samples: &[Sample], timestamp_ms: i64, range_ms: i64) -> Option<f64> {
    let first = samples.first()?;
    let last = samples.last()?;
    match name {
        "rate" | "increase" | "delta" => extrapolated_change(
            samples,
            timestamp_ms,
            range_ms,
            name != "delta",
            name == "rate",
        ),
        "irate" | "idelta" => {
            if samples.len() < 2 {
                return None;
            }
            let previous = &samples[samples.len() - 2];
            let mut delta = last.value - previous.value;
            if name == "irate" && last.value < previous.value {
                delta = last.value;
            }
            Some(if name == "irate" {
                delta / ((last.timestamp_ms - previous.timestamp_ms) as f64 / 1000.0)
            } else {
                delta
            })
        }
        "sum_over_time" => Some(compensated_sum(samples.iter().map(|sample| sample.value))),
        "avg_over_time" => Some(safe_mean(samples.iter().map(|sample| sample.value))),
        "min_over_time" => Some(
            samples
                .iter()
                .map(|sample| sample.value)
                .fold(f64::NAN, f64::min),
        ),
        "max_over_time" => Some(
            samples
                .iter()
                .map(|sample| sample.value)
                .fold(f64::NAN, f64::max),
        ),
        "count_over_time" => Some(samples.len() as f64),
        "last_over_time" => Some(last.value),
        "present_over_time" => Some(1.0),
        "changes" => Some(
            samples
                .windows(2)
                .filter(|pair| {
                    pair[0].value != pair[1].value
                        && !(pair[0].value.is_nan() && pair[1].value.is_nan())
                })
                .count() as f64,
        ),
        "resets" => Some(
            samples
                .windows(2)
                .filter(|pair| pair[1].value < pair[0].value)
                .count() as f64,
        ),
        _ => {
            let _ = first;
            None
        }
    }
}

// Implements the documented extrapolation rules for ordinary float counters,
// independently of Enterprise code: reset correction, the 1.1 sample-spacing
// threshold, half-interval extrapolation, and counter zero-point clipping.
fn extrapolated_change(
    samples: &[Sample],
    timestamp_ms: i64,
    range_ms: i64,
    counter: bool,
    rate: bool,
) -> Option<f64> {
    if samples.len() < 2 {
        return None;
    }
    let first = &samples[0];
    let last = &samples[samples.len() - 1];
    let mut delta = last.value - first.value;
    if counter {
        for pair in samples.windows(2) {
            if pair[1].value < pair[0].value {
                delta += pair[0].value;
            }
        }
    }
    let interval = (last.timestamp_ms - first.timestamp_ms) as f64 / 1000.0;
    let average = interval / (samples.len() - 1) as f64;
    let threshold = average * 1.1;
    let mut to_start = (first.timestamp_ms - (timestamp_ms - range_ms)) as f64 / 1000.0;
    let mut to_end = (timestamp_ms - last.timestamp_ms) as f64 / 1000.0;
    if to_start >= threshold {
        to_start = average / 2.0;
    }
    if counter && delta > 0.0 && first.value >= 0.0 {
        to_start = to_start.min(interval * first.value / delta);
    }
    if to_end >= threshold {
        to_end = average / 2.0;
    }
    let mut factor = (interval + to_start + to_end) / interval;
    if rate {
        factor /= range_ms as f64 / 1000.0;
    }
    Some(delta * factor)
}

#[cfg(test)]
mod tests;
