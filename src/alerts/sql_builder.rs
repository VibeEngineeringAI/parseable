//! Versioned SQL alert authoring. Persist raw specs; normalize only on save/preview.
use arrow_schema::{DataType, Schema};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

use super::{
    AggregateFunction, AlertError, AlertQueryType, EvalConfig, WhereConfigOperator,
    alert_structs::{ConditionConfig, Conditions, ThresholdConfig},
    alerts_utils::{get_filter_string, quote_identifier},
};

pub const MEASURE: &str = "alert_value";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SqlBuilderV1 {
    pub kind: String,
    pub version: u32,
    pub dataset: String,
    pub aggregate: BuilderAggregate,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filters: Option<Conditions>,
    #[serde(default)]
    pub group_by: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuilderAggregate {
    pub function: AggregateFunction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
}

fn invalid(path: &str, message: impl std::fmt::Display) -> AlertError {
    AlertError::ValidationFailure(format!("builderConfig.{path}: {message}"))
}

pub fn parse(value: &Value) -> Result<SqlBuilderV1, AlertError> {
    let spec: SqlBuilderV1 =
        serde_json::from_value(value.clone()).map_err(|error| invalid("", error))?;
    if spec.kind != "sql" || spec.version != 1 {
        return Err(invalid("version", "only kind sql, version 1 is supported"));
    }
    if let Some(filters) = value.get("filters").filter(|value| !value.is_null()) {
        check_filter_keys(filters, "filters", 0)?;
    }
    Ok(spec)
}

fn check_filter_keys(value: &Value, path: &str, depth: usize) -> Result<(), AlertError> {
    if depth > 3 {
        return Err(invalid(path, "nesting exceeds 3"));
    }
    if let Some(fields) = value.as_object() {
        for key in fields.keys() {
            if !["operator", "conditionConfig", "groups"].contains(&key.as_str()) {
                return Err(invalid(path, format!("unknown field {key}")));
            }
        }
    }
    if let Some(conditions) = value.get("conditionConfig").and_then(Value::as_array) {
        for (index, condition) in conditions.iter().enumerate() {
            if let Some(fields) = condition.as_object() {
                for key in fields.keys() {
                    if !["column", "operator", "value", "type"].contains(&key.as_str()) {
                        return Err(invalid(
                            &format!("{path}.conditionConfig[{index}]"),
                            format!("unknown field {key}"),
                        ));
                    }
                }
            }
        }
    }
    if let Some(groups) = value.get("groups").and_then(Value::as_array) {
        for (index, group) in groups.iter().enumerate() {
            check_filter_keys(group, &format!("{path}.groups[{index}]"), depth + 1)?;
        }
    }
    Ok(())
}

fn field_type<'a>(
    schema: &'a Schema,
    column: &str,
    path: &str,
) -> Result<&'a DataType, AlertError> {
    schema
        .field_with_name(column)
        .map(|field| field.data_type())
        .map_err(|_| invalid(path, format!("unknown column {column}")))
}

fn canonical_type(data_type: &DataType) -> Option<&'static str> {
    use DataType::*;
    match data_type {
        Int8 | Int16 | Int32 | Int64 | UInt8 | UInt16 | UInt32 | UInt64 => Some("int"),
        Float16 | Float32 | Float64 | Decimal128(_, _) | Decimal256(_, _) => Some("float"),
        Boolean => Some("boolean"),
        Utf8 | LargeUtf8 | Utf8View => Some("string"),
        Timestamp(_, _) | Date32 | Date64 => Some("timestamp"),
        List(field)
        | LargeList(field)
        | FixedSizeList(field, _)
        | ListView(field)
        | LargeListView(field)
            if matches!(
                canonical_type(field.data_type()),
                Some("int" | "float" | "boolean" | "string")
            ) =>
        {
            Some("list")
        }
        _ => None,
    }
}

fn validate_identifier(value: &str, path: &str) -> Result<(), AlertError> {
    if value.is_empty() || value.contains('\0') || value.chars().count() > 1024 {
        return Err(invalid(
            path,
            "must be nonempty, contain no NUL, and have at most 1024 characters",
        ));
    }
    Ok(())
}

pub fn normalize(mut spec: SqlBuilderV1, schema: &Schema) -> Result<SqlBuilderV1, AlertError> {
    validate_identifier(&spec.dataset, "dataset")?;
    if let Some(column) = &spec.aggregate.column {
        validate_identifier(column, "aggregate.column")?;
        let ty = field_type(schema, column, "aggregate.column")?;
        if !matches!(spec.aggregate.function, AggregateFunction::Count)
            && !matches!(canonical_type(ty), Some("int" | "float"))
        {
            return Err(invalid("aggregate.column", "must be a numeric column"));
        }
    } else if !matches!(spec.aggregate.function, AggregateFunction::Count) {
        return Err(invalid("aggregate.column", "required for this aggregate"));
    }
    if matches!(spec.aggregate.function, AggregateFunction::CountDistinct) {
        return Err(invalid(
            "aggregate.function",
            "countDistinct is unsupported in version 1",
        ));
    }
    if spec.group_by.len() > 3 {
        return Err(invalid("groupBy", "at most 3 columns"));
    }
    let mut seen = HashSet::new();
    for (index, column) in spec.group_by.iter().enumerate() {
        let path = format!("groupBy[{index}]");
        validate_identifier(column, &path)?;
        if column == MEASURE || column == "p_timestamp" || !seen.insert(column) {
            return Err(invalid(&path, "duplicate or reserved grouping column"));
        }
        if !matches!(
            canonical_type(field_type(schema, column, &path)?),
            Some("string" | "int" | "boolean")
        ) {
            return Err(invalid(
                &path,
                "grouping supports string, integer and boolean columns",
            ));
        }
    }
    if let Some(filters) = spec.filters.as_mut() {
        if filters.condition_config.is_empty() && filters.groups.as_ref().is_none_or(Vec::is_empty)
        {
            spec.filters = None;
        } else {
            let mut counts = (0usize, 0usize);
            normalize_filters(filters, schema, "filters", 0, &mut counts)?;
        }
    }
    Ok(spec)
}

fn normalize_filters(
    filters: &mut Conditions,
    schema: &Schema,
    path: &str,
    depth: usize,
    counts: &mut (usize, usize),
) -> Result<(), AlertError> {
    if depth > 3 {
        return Err(invalid(path, "nesting exceeds 3"));
    }
    if filters.condition_config.is_empty() && filters.groups.as_ref().is_none_or(Vec::is_empty) {
        return Err(invalid(path, "empty nested groups are unsupported"));
    }
    counts.0 += filters.condition_config.len();
    if counts.0 > 20 {
        return Err(invalid(path, "at most 20 conditions"));
    }
    for (index, condition) in filters.condition_config.iter_mut().enumerate() {
        let path = format!("{path}.conditionConfig[{index}]");
        validate_identifier(&condition.column, &path)?;
        let ty = canonical_type(field_type(schema, &condition.column, &path)?)
            .ok_or_else(|| invalid(&path, "unsupported column type"))?;
        condition.column_type = Some(ty.into());
        normalize_condition(condition, ty, &path)?;
    }
    if let Some(groups) = filters.groups.as_mut() {
        counts.1 += groups.len();
        if counts.1 > 10 {
            return Err(invalid(path, "at most 10 groups"));
        }
        for (index, group) in groups.iter_mut().enumerate() {
            normalize_filters(
                group,
                schema,
                &format!("{path}.groups[{index}]"),
                depth + 1,
                counts,
            )?;
        }
    }
    Ok(())
}

fn normalize_condition(
    condition: &mut ConditionConfig,
    ty: &str,
    path: &str,
) -> Result<(), AlertError> {
    use WhereConfigOperator::*;
    let value = condition.value.as_deref().unwrap_or("");
    if value.contains('\0') || value.chars().count() > 1024 {
        return Err(invalid(
            path,
            "value must have no NUL and at most 1024 characters",
        ));
    }
    if matches!(condition.operator, IsNull | IsNotNull) {
        if !value.is_empty() {
            return Err(invalid(path, "null operators take no value"));
        }
        condition.value = None;
        return Ok(());
    }
    let allowed = match ty {
        "string" => matches!(
            condition.operator,
            Equal
                | NotEqual
                | ILike
                | Contains
                | BeginsWith
                | EndsWith
                | DoesNotContain
                | DoesNotBeginWith
                | DoesNotEndWith
        ),
        "int" | "float" | "timestamp" => matches!(
            condition.operator,
            Equal | NotEqual | LessThan | GreaterThan | LessThanOrEqual | GreaterThanOrEqual
        ),
        "boolean" => matches!(condition.operator, Equal | NotEqual),
        "list" => matches!(
            condition.operator,
            Contains | DoesNotContain | Equal | NotEqual
        ),
        _ => false,
    };
    if !allowed {
        return Err(invalid(path, format!("operator is unsupported for {ty}")));
    }
    let normalized = match ty {
        "int" => value
            .parse::<i64>()
            .map(|value| value.to_string())
            .or_else(|_| value.parse::<u64>().map(|value| value.to_string()))
            .map_err(|_| invalid(path, "expected an exact i64/u64 integer"))?,
        "float" => {
            let number = value
                .parse::<f64>()
                .map_err(|_| invalid(path, "expected a finite number"))?;
            if !number.is_finite() {
                return Err(invalid(path, "expected a finite number"));
            }
            number.to_string()
        }
        "boolean" => value
            .parse::<bool>()
            .map_err(|_| invalid(path, "expected true or false"))?
            .to_string(),
        "timestamp" => {
            chrono::DateTime::parse_from_rfc3339(value)
                .map_err(|_| invalid(path, "expected RFC3339 timestamp"))?;
            value.to_owned()
        }
        _ => value.to_owned(),
    };
    condition.value = Some(normalized);
    // Validate list literal syntax through the same safe compiler used for execution.
    if ty == "list" {
        get_filter_string(&Conditions {
            operator: None,
            condition_config: vec![condition.clone()],
            groups: None,
        })
        .map_err(|error| invalid(path, error))?;
    }
    Ok(())
}

/// Frozen version-1 compiler. Any intentional SQL output change requires v2.
pub fn compile(spec: &SqlBuilderV1) -> Result<String, AlertError> {
    if spec.kind != "sql"
        || spec.version != 1
        || matches!(spec.aggregate.function, AggregateFunction::CountDistinct)
    {
        return Err(invalid("version", "unsupported specification"));
    }
    let aggregate = match spec.aggregate.function {
        AggregateFunction::Count => "COUNT",
        AggregateFunction::Sum => "SUM",
        AggregateFunction::Avg => "AVG",
        AggregateFunction::Min => "MIN",
        AggregateFunction::Max => "MAX",
        AggregateFunction::CountDistinct => unreachable!(),
    };
    let column = spec
        .aggregate
        .column
        .as_ref()
        .map(|column| quote_identifier(column));
    if column.is_none() && aggregate != "COUNT" {
        return Err(invalid("aggregate.column", "required"));
    }
    let grouping = spec
        .group_by
        .iter()
        .map(|column| quote_identifier(column))
        .collect::<Vec<_>>();
    let mut projections = grouping.clone();
    projections.push(format!(
        "{aggregate}({}) AS {}",
        column.as_deref().unwrap_or("*"),
        quote_identifier(MEASURE)
    ));
    let mut sql = format!(
        "SELECT {} FROM {}",
        projections.join(", "),
        quote_identifier(&spec.dataset)
    );
    if let Some(filters) = &spec.filters {
        sql.push_str(" WHERE ");
        sql.push_str(&get_filter_string(filters).map_err(|error| invalid("filters", error))?);
    }
    if !grouping.is_empty() {
        sql.push_str(&format!(" GROUP BY {}", grouping.join(", ")));
    }
    Ok(sql)
}

pub fn enforce_precedence(
    query_type: AlertQueryType,
    query: &str,
    has_spec: bool,
    compiled: Option<&str>,
    stored_had_spec: bool,
) -> Result<(), AlertError> {
    match query_type {
        AlertQueryType::Code if has_spec => Err(AlertError::BuilderConflict("omit builderConfig to convert".into())),
        AlertQueryType::Promql if has_spec => Err(invalid("", "PromQL rules cannot have a SQL specification")),
        AlertQueryType::Builder if !has_spec && stored_had_spec => Err(AlertError::BuilderConflict("builderConfig is required to edit this builder rule; set queryType code to convert".into())),
        AlertQueryType::Builder if has_spec && !query.trim().is_empty() && compiled.is_some_and(|compiled| query.trim() != compiled) => Err(AlertError::BuilderConflict("query does not match builderConfig; omit builderConfig and set queryType code to edit SQL directly".into())),
        _ => Ok(()),
    }
}

pub fn validate_rule_bounds(
    eval: &EvalConfig,
    threshold: &ThresholdConfig,
) -> Result<(), AlertError> {
    let EvalConfig::RollingWindow(window) = eval;
    let duration = humantime::parse_duration(&window.eval_start)
        .map_err(|_| invalid("evalConfig", "invalid evalStart duration"))?;
    if duration.as_secs() > 30 * 86400
        || window.eval_frequency == 0
        || window.eval_frequency > 1440
        || !threshold.value.is_finite()
    {
        return Err(invalid(
            "evalConfig",
            "evalStart <=30 days, evalFrequency 1..1440 and a finite threshold are required",
        ));
    }
    Ok(())
}

fn authorize_dataset(dataset: &str, allowed: impl FnOnce(&str) -> bool) -> Result<(), AlertError> {
    if allowed(dataset) {
        Ok(())
    } else {
        Err(AlertError::Unauthorized)
    }
}

pub async fn prepare(
    query_type: AlertQueryType,
    query: &str,
    spec: Option<Value>,
    eval: &EvalConfig,
    threshold: &ThresholdConfig,
    tenant: &Option<String>,
    session: &crate::rbac::map::SessionKey,
) -> Result<(String, Option<Value>), AlertError> {
    enforce_precedence(query_type, query, spec.is_some(), None, false)?;
    let Some(spec) = spec else {
        return Ok((query.to_owned(), None));
    };
    let spec = parse(&spec)?;
    // Check access using the selected resource before consulting schema or
    // existence. Callers cannot bypass this by omitting their identity.
    authorize_dataset(&spec.dataset, |dataset| {
        crate::rbac::Users.authorize(
            session.clone(),
            crate::rbac::role::Action::Query,
            Some(dataset),
            None,
        ) == crate::rbac::Response::Authorized
    })?;
    let requester_tenant = crate::utils::get_tenant_id_from_key(session);
    if requester_tenant
        .as_deref()
        .unwrap_or(crate::parseable::DEFAULT_TENANT)
        != tenant
            .as_deref()
            .unwrap_or(crate::parseable::DEFAULT_TENANT)
    {
        return Err(AlertError::Unauthorized);
    }
    validate_rule_bounds(eval, threshold)?;
    if !crate::parseable::PARSEABLE
        .check_or_load_stream(&spec.dataset, tenant)
        .await
    {
        return Err(AlertError::Unauthorized);
    }
    let stream = crate::parseable::PARSEABLE
        .get_stream(&spec.dataset, tenant)
        .map_err(|_| AlertError::Unauthorized)?;
    if stream.get_stream_type() == crate::storage::StreamType::Internal {
        return Err(invalid(
            "dataset",
            "internal datasets cannot be used by the builder",
        ));
    }
    let spec = normalize(spec, &stream.get_schema())?;
    let compiled = compile(&spec)?;
    enforce_precedence(query_type, query, true, Some(&compiled), false)?;
    if crate::query::resolve_stream_names(&compiled)? != [spec.dataset.clone()] {
        return Err(invalid(
            "dataset",
            "compiled SQL must resolve exactly the selected dataset",
        ));
    }
    Ok((compiled, Some(serde_json::to_value(spec)?)))
}

pub fn builder_status(spec: &Value, query: &str) -> &'static str {
    if parse(spec)
        .and_then(|spec| compile(&spec))
        .is_ok_and(|compiled| compiled == query)
    {
        "editable"
    } else {
        "unsupported"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_schema::{Field, TimeUnit};
    use serde_json::json;

    fn schema() -> Schema {
        Schema::new(vec![
            Field::new("service", DataType::Utf8, true),
            Field::new("level", DataType::Utf8, true),
            Field::new("units", DataType::Int64, true),
            Field::new("unsigned", DataType::UInt64, true),
            Field::new("latency", DataType::Float64, true),
            Field::new("decimal", DataType::Decimal128(20, 2), true),
            Field::new("active", DataType::Boolean, true),
            Field::new(
                "time",
                DataType::Timestamp(TimeUnit::Millisecond, None),
                true,
            ),
            Field::new("date", DataType::Date32, true),
            Field::new(
                "tags",
                DataType::List(std::sync::Arc::new(Field::new(
                    "item",
                    DataType::Utf8,
                    true,
                ))),
                true,
            ),
            Field::new("p_timestamp", DataType::Utf8, true),
            Field::new(MEASURE, DataType::Utf8, true),
            Field::new("binary", DataType::Binary, true),
        ])
    }
    fn spec() -> Value {
        json!({"kind":"sql","version":1,"dataset":"app-logs","aggregate":{"function":"count"},"groupBy":[]})
    }
    fn normalized(value: Value) -> SqlBuilderV1 {
        normalize(parse(&value).unwrap(), &schema()).unwrap()
    }
    fn filter(column: &str, op: &str, value: &str) -> Value {
        let mut spec = spec();
        spec["filters"] = json!({"operator":"and","conditionConfig":[{"column":column,"operator":op,"value":value,"type":"ignored"}]});
        spec
    }

    #[test]
    fn unauthorized_builder_probes_return_identical_forbidden_before_schema_checks() {
        use actix_web::ResponseError;
        let mut bodies = Vec::new();
        for dataset in ["private", "nonexistent"] {
            for column in ["numeric", "string", "nonexistent"] {
                let mut probe = filter(column, "=", "1");
                probe["dataset"] = json!(dataset);
                let spec = parse(&probe).unwrap();
                let result = authorize_dataset(&spec.dataset, |_| false)
                    .and_then(|_| normalize(spec, &schema()));
                let error = result.unwrap_err();
                assert_eq!(error.status_code(), actix_web::http::StatusCode::FORBIDDEN);
                bodies.push(error.to_string());
            }
        }
        assert!(bodies.iter().all(|body| body == &bodies[0]));
        assert_eq!(bodies[0], AlertError::Unauthorized.to_string());
    }

    #[test]
    fn golden_sql_for_all_v1_aggregates_and_count_column() {
        assert_eq!(
            compile(&normalized(spec())).unwrap(),
            "SELECT COUNT(*) AS \"alert_value\" FROM \"app-logs\""
        );
        for (function, sql_name) in [
            ("count", "COUNT"),
            ("sum", "SUM"),
            ("avg", "AVG"),
            ("min", "MIN"),
            ("max", "MAX"),
        ] {
            let mut spec = spec();
            spec["aggregate"] = json!({"function":function,"column":"latency"});
            spec["groupBy"] = json!(["service", "active"]);
            assert_eq!(
                compile(&normalized(spec)).unwrap(),
                format!(
                    r#"SELECT "service", "active", {sql_name}("latency") AS "alert_value" FROM "app-logs" GROUP BY "service", "active""#
                )
            );
        }
    }

    #[test]
    fn typed_scalar_operators_and_nulls_have_golden_sql() {
        for op in ["=", "!=", "<", ">", "<=", ">="] {
            assert!(
                compile(&normalized(filter("units", op, "9223372036854775807")))
                    .unwrap()
                    .ends_with(&format!("WHERE \"units\" {op} 9223372036854775807"))
            );
            assert!(
                compile(&normalized(filter("latency", op, "1.25")))
                    .unwrap()
                    .ends_with(&format!("WHERE \"latency\" {op} 1.25"))
            );
            assert!(
                compile(&normalized(filter("time", op, "2026-10-01T00:00:00Z")))
                    .unwrap()
                    .ends_with(&format!("WHERE \"time\" {op} '2026-10-01T00:00:00Z'"))
            );
        }
        for op in ["=", "!="] {
            assert!(
                compile(&normalized(filter("active", op, "true")))
                    .unwrap()
                    .ends_with(&format!("WHERE \"active\" {op} true"))
            );
            assert!(
                compile(&normalized(filter("level", op, "error's")))
                    .unwrap()
                    .ends_with(&format!("WHERE \"level\" {op} 'error''s'"))
            );
        }
        for column in ["level", "units", "latency", "active", "time", "tags"] {
            for (operator, sql) in [("is null", "is null"), ("is not null", "is not null")] {
                assert!(
                    compile(&normalized(filter(column, operator, "")))
                        .unwrap()
                        .ends_with(&format!("WHERE \"{column}\" {sql}"))
                );
            }
        }
    }

    #[test]
    fn string_and_list_operators_have_golden_sql() {
        let escaped = r"a\%b\_c\\d''e";
        for (operator, expected) in [
            ("contains", format!("LIKE '%{escaped}%'")),
            ("does not contain", format!("NOT LIKE '%{escaped}%'")),
            ("ilike", format!("ILIKE '%{escaped}%'")),
            ("begins with", format!("LIKE '{escaped}%'")),
            ("does not begin with", format!("NOT LIKE '{escaped}%'")),
            ("ends with", format!("LIKE '%{escaped}'")),
            ("does not end with", format!("NOT LIKE '%{escaped}'")),
        ] {
            let sql = compile(&normalized(filter("level", operator, r"a%b_c\d'e"))).unwrap();
            assert!(
                sql.ends_with(&format!("WHERE \"level\" {expected} ESCAPE '\\'")),
                "{sql}"
            );
        }
        for (operator, expected) in [
            ("contains", "array_has_all(\"tags\", ARRAY['a', 'b'])"),
            (
                "does not contain",
                "NOT array_has_all(\"tags\", ARRAY['a', 'b'])",
            ),
            ("=", "\"tags\" = ARRAY['a', 'b']"),
            ("!=", "\"tags\" != ARRAY['a', 'b']"),
        ] {
            assert!(
                compile(&normalized(filter("tags", operator, "'a', 'b'")))
                    .unwrap()
                    .ends_with(expected)
            );
        }
    }

    #[test]
    fn schema_types_override_client_types_and_integer_literals_stay_exact() {
        let spec = normalized(filter("unsigned", "=", "18446744073709551615"));
        assert_eq!(
            spec.filters.as_ref().unwrap().condition_config[0]
                .column_type
                .as_deref(),
            Some("int")
        );
        assert!(compile(&spec).unwrap().contains("= 18446744073709551615"));
        for value in ["NaN", "inf", "1e400", "1.5", "18446744073709551616"] {
            assert!(normalize(parse(&filter("unsigned", "=", value)).unwrap(), &schema()).is_err());
        }
        for value in ["NaN", "inf", "-inf", "1e400"] {
            assert!(normalize(parse(&filter("latency", "=", value)).unwrap(), &schema()).is_err());
            assert!(
                normalize(
                    parse(&filter("tags", "contains", value)).unwrap(),
                    &schema()
                )
                .is_err()
            );
        }
    }

    #[test]
    fn nested_groups_are_parenthesized_and_empty_root_is_pruned() {
        let mut spec = spec();
        spec["filters"] = json!({"operator":"and","conditionConfig":[{"column":"active","operator":"=","value":"true"}],"groups":[{"operator":"or","conditionConfig":[{"column":"level","operator":"=","value":"error"},{"column":"units","operator":">","value":"10"}]}]});
        assert!(
            compile(&normalized(spec))
                .unwrap()
                .ends_with("WHERE \"active\" = true AND (\"level\" = 'error' OR \"units\" > 10)")
        );
        let mut spec = self::spec();
        spec["filters"] = json!({"conditionConfig":[],"groups":[]});
        assert!(normalized(spec).filters.is_none());
    }

    #[test]
    fn quotes_and_metacharacters_cannot_escape_identifiers_or_literals() {
        let column = "level\"; DROP TABLE logs;--";
        let dataset = "app.logs-\";--";
        let schema = Schema::new(vec![Field::new(column, DataType::Utf8, true)]);
        let mut spec = filter(column, "=", "x'); DROP TABLE logs;--%_\\]");
        spec["dataset"] = json!(dataset);
        let spec = normalize(parse(&spec).unwrap(), &schema).unwrap();
        let sql = compile(&spec).unwrap();
        assert_eq!(crate::query::resolve_stream_names(&sql).unwrap(), [dataset]);
        assert!(
            sql.contains("\"level\"\"; DROP TABLE logs;--\" = 'x''); DROP TABLE logs;--%_\\]'")
        );
        assert!(
            normalize(
                parse(&filter("tags", "contains", "x]); DROP TABLE logs;--")).unwrap(),
                &self::schema()
            )
            .is_err()
        );
        for dataset in ["app.logs", "app-logs"] {
            let mut spec = self::spec();
            spec["dataset"] = json!(dataset);
            assert_eq!(
                crate::query::resolve_stream_names(&compile(&normalized(spec)).unwrap()).unwrap(),
                [dataset]
            );
        }
    }

    #[test]
    fn invalid_schema_operators_groups_and_bounds_are_rejected() {
        for (column, op, value) in [
            ("binary", "=", "x"),
            ("missing", "=", "x"),
            ("active", ">", "true"),
            ("level", ">", "x"),
            ("units", "contains", "1"),
            ("time", "=", "today"),
            ("units", "is null", "1"),
            ("level", "=", "\0"),
        ] {
            assert!(
                normalize(parse(&filter(column, op, value)).unwrap(), &schema()).is_err(),
                "{column} {op}"
            );
        }
        let mut too_long = filter("level", "=", "x");
        too_long["filters"]["conditionConfig"][0]["value"] = json!("x".repeat(1025));
        assert!(normalize(parse(&too_long).unwrap(), &schema()).is_err());
        for group_by in [
            json!(["service", "service"]),
            json!(["p_timestamp"]),
            json!([MEASURE]),
            json!(["latency"]),
            json!(["service", "level", "units", "active"]),
        ] {
            let mut spec = spec();
            spec["groupBy"] = group_by;
            assert!(normalize(parse(&spec).unwrap(), &schema()).is_err());
        }
        for aggregate in [
            json!({"function":"sum"}),
            json!({"function":"sum","column":"service"}),
            json!({"function":"countDistinct","column":"units"}),
        ] {
            let mut spec = spec();
            spec["aggregate"] = aggregate;
            assert!(normalize(parse(&spec).unwrap(), &schema()).is_err());
        }
        let mut spec = self::spec();
        spec["filters"] = json!({"groups":[{"conditionConfig":[]}]});
        assert!(normalize(parse(&spec).unwrap(), &schema()).is_err());
        let condition = json!({"column":"units","operator":"=","value":"1"});
        let mut spec = self::spec();
        spec["filters"] = json!({"conditionConfig":vec![condition.clone();21]});
        assert!(normalize(parse(&spec).unwrap(), &schema()).is_err());
        let group = json!({"conditionConfig":[condition]});
        let mut spec = self::spec();
        spec["filters"] = json!({"groups":vec![group.clone();11]});
        assert!(normalize(parse(&spec).unwrap(), &schema()).is_err());
        let mut deep = group;
        for _ in 0..4 {
            deep = json!({"groups":[deep]});
        }
        let mut spec = self::spec();
        spec["filters"] = deep;
        assert!(parse(&spec).is_err());
        let mut spec = self::spec();
        spec["future"] = json!(true);
        assert!(parse(&spec).is_err());
    }

    #[test]
    fn every_precedence_case_is_explicit_for_create_and_edit() {
        use actix_web::ResponseError;
        for existing_spec in [false, true] {
            for query in ["", "SELECT", " SELECT "] {
                assert!(
                    enforce_precedence(
                        AlertQueryType::Builder,
                        query,
                        true,
                        Some("SELECT"),
                        existing_spec
                    )
                    .is_ok()
                );
            }
            let mismatch = enforce_precedence(
                AlertQueryType::Builder,
                "SELECT evil",
                true,
                Some("SELECT"),
                existing_spec,
            )
            .unwrap_err();
            assert_eq!(
                mismatch.status_code(),
                actix_web::http::StatusCode::CONFLICT
            );
            assert!(
                enforce_precedence(AlertQueryType::Code, "SELECT", false, None, existing_spec)
                    .is_ok()
            );
            assert!(matches!(
                enforce_precedence(AlertQueryType::Code, "SELECT", true, None, existing_spec),
                Err(AlertError::BuilderConflict(_))
            ));
            assert!(matches!(
                enforce_precedence(AlertQueryType::Promql, "up", true, None, existing_spec),
                Err(AlertError::ValidationFailure(_))
            ));
            assert_eq!(
                enforce_precedence(
                    AlertQueryType::Builder,
                    "SELECT",
                    false,
                    None,
                    existing_spec
                )
                .is_ok(),
                !existing_spec
            );
        }
        let mut unknown = spec();
        unknown["version"] = json!(2);
        assert!(parse(&unknown).is_err());
        assert_eq!(builder_status(&unknown, "SELECT"), "unsupported");
    }

    #[test]
    fn rule_limits_are_scoped_to_supported_builder_specs() {
        let threshold = ThresholdConfig {
            operator: super::super::AlertOperator::GreaterThan,
            value: 1.0,
        };
        for (duration, frequency, valid) in [
            ("30d", 1440, true),
            ("31d", 1, false),
            ("5m", 0, false),
            ("5m", 1441, false),
        ] {
            let eval = EvalConfig::RollingWindow(super::super::RollingWindow {
                eval_start: duration.into(),
                eval_end: "now".into(),
                eval_frequency: frequency,
            });
            assert_eq!(validate_rule_bounds(&eval, &threshold).is_ok(), valid);
        }
        let mut bad = threshold;
        bad.value = f64::INFINITY;
        assert!(
            validate_rule_bounds(&EvalConfig::RollingWindow(Default::default()), &bad).is_err()
        );
    }
}

#[cfg(test)]
mod plan_tests {
    use super::*;
    use arrow_array::RecordBatch;
    use arrow_schema::Field;
    use datafusion::prelude::SessionContext;
    use std::sync::Arc;

    #[tokio::test]
    async fn compiled_sql_keeps_single_aggregate_and_correct_dimensions() {
        for function in ["count", "sum", "avg", "min", "max"] {
            let schema = Schema::new(vec![
                Field::new("service", DataType::Utf8, true),
                Field::new("latency", DataType::Float64, true),
            ]);
            let ctx = SessionContext::new();
            ctx.register_batch(
                datafusion::common::TableReference::bare("app.logs"),
                RecordBatch::new_empty(Arc::new(schema.clone())),
            )
            .unwrap();
            let spec = normalize(parse(&serde_json::json!({"kind":"sql","version":1,"dataset":"app.logs","aggregate":{"function":function,"column":"latency"},"groupBy":["service"]})).unwrap(), &schema).unwrap();
            let dataframe = ctx.sql(&compile(&spec).unwrap()).await.unwrap();
            let plan = dataframe.logical_plan();
            assert_eq!(
                super::super::get_number_of_agg_exprs_from_plan(plan).unwrap(),
                1
            );
            let layout = super::super::resolve_alert_output_layout(plan).unwrap();
            assert_eq!(layout.measure_name, MEASURE);
            assert_eq!(layout.dimension_indices, [0]);
        }
    }
}
