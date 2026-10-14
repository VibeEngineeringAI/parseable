//! Docs-derived fixture codecs; never perform network calls or execute advice.
//! Sources checked 2026-10-13: https://docs.typesafe.ai/api and
//! https://developers.openai.com/api/reference/resources/decisions/methods/create
use super::{FrozenProviderContext, MAX_RESPONSE_BYTES, ProviderError, ProviderKind};
use async_trait::async_trait;
use serde::{
    Deserialize, Serialize,
    de::{self, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};

const MAX_QUESTIONS: usize = 32;
const MAX_RUBRIC_BYTES: usize = 32 * 1024;
const TOLERANCE: f64 = 1e-5;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChoiceOption {
    pub value: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScoreLevel {
    pub label: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum QuestionKind {
    Predicate,
    Choice { choices: Vec<ChoiceOption> },
    Score { levels: Vec<ScoreLevel> },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DecisionQuestion {
    pub id: String,
    pub instructions: String,
    pub kind: QuestionKind,
}

/// Closed rubrics can return suggestions, never SQL/tool arguments/scope changes.
#[derive(Clone)]
pub struct DecisionRequest {
    pub context: FrozenProviderContext,
    pub questions: Vec<DecisionQuestion>,
    pub rubric_version: String,
}

impl fmt::Debug for DecisionRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DecisionRequest")
            .field("question_count", &self.questions.len())
            .finish_non_exhaustive()
    }
}

impl DecisionRequest {
    pub fn validate(&self) -> Result<(), ProviderError> {
        if self.questions.is_empty()
            || self.questions.len() > MAX_QUESTIONS
            || self.rubric_version.is_empty()
            || self.rubric_version.len() > 128
        {
            return Err(ProviderError::InvalidQuestions);
        }
        let mut ids = BTreeSet::new();
        for q in &self.questions {
            if q.id.is_empty()
                || q.id.len() > 64
                || !q
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
                || !ids.insert(&q.id)
                || q.instructions.is_empty()
            {
                return Err(ProviderError::InvalidQuestions);
            }
            match &q.kind {
                QuestionKind::Predicate => {}
                QuestionKind::Choice { choices } => {
                    if !(2..=255).contains(&choices.len())
                        || choices.iter().any(|c| c.value.is_empty())
                        || choices
                            .iter()
                            .map(|c| &c.value)
                            .collect::<BTreeSet<_>>()
                            .len()
                            != choices.len()
                    {
                        return Err(ProviderError::InvalidQuestions);
                    }
                }
                QuestionKind::Score { levels } => {
                    if !(2..=10).contains(&levels.len())
                        || levels
                            .iter()
                            .any(|l| l.label.is_empty() || l.description.is_empty())
                        || levels
                            .iter()
                            .map(|l| &l.label)
                            .collect::<BTreeSet<_>>()
                            .len()
                            != levels.len()
                    {
                        return Err(ProviderError::InvalidQuestions);
                    }
                }
            }
        }
        let rubric =
            serde_json::to_vec(&self.questions).map_err(|_| ProviderError::InvalidQuestions)?;
        if rubric.len() > MAX_RUBRIC_BYTES {
            return Err(ProviderError::InvalidQuestions);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ChoiceProbability {
    pub value: String,
    pub probability: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScoreProbability {
    pub value: u32,
    pub label: String,
    pub probability: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AdvisoryAnswer {
    Predicate {
        probability: f64,
    },
    Choice {
        choice: String,
        probabilities: Vec<ChoiceProbability>,
        native_confidence: f64,
    },
    Score {
        score: f64,
        minimum: u32,
        maximum: u32,
        probabilities: Vec<ScoreProbability>,
        native_confidence: f64,
    },
    Refusal,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DecisionResult {
    pub provider: ProviderKind,
    pub requested_model: String,
    pub resolved_model: String,
    pub context_hash: String,
    pub rubric_version: String,
    pub answers: BTreeMap<String, AdvisoryAnswer>,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[async_trait]
pub trait DecisionProvider: Send + Sync {
    async fn evaluate(&self, request: &DecisionRequest) -> Result<DecisionResult, ProviderError>;
}

#[derive(Default)]
pub struct UnavailableDecisionProvider;

#[async_trait]
impl DecisionProvider for UnavailableDecisionProvider {
    async fn evaluate(&self, _: &DecisionRequest) -> Result<DecisionResult, ProviderError> {
        Err(ProviderError::ProductionUnavailable)
    }
}

/// This has no credentials, transport, session state, or executable capabilities.
#[derive(Clone, Copy, Debug)]
pub struct DecisionCodec(pub ProviderKind);

impl DecisionCodec {
    pub fn request_body(&self, request: &DecisionRequest) -> Result<Value, ProviderError> {
        request.validate()?;
        match self.0 {
            ProviderKind::OpenAiResponses | ProviderKind::OpenRouterChat => {
                Err(ProviderError::InvalidConfiguration)
            }
            ProviderKind::OpenAiDecisions => {
                let questions: Vec<Value> = request.questions.iter().map(|q| match &q.kind {
                    QuestionKind::Predicate => json!({"type":"predicate", "name":q.id, "instructions":q.instructions}),
                    QuestionKind::Choice { choices } => json!({"type":"choice", "name":q.id, "instructions":q.instructions, "choices":choices}),
                    QuestionKind::Score { levels } => json!({"type":"score", "name":q.id, "instructions":q.instructions, "levels":levels}),
                }).collect();
                Ok(
                    json!({"model":self.0.model(), "input":request.context.serialized(), "questions":questions}),
                )
            }
            ProviderKind::Jev => {
                let questions: BTreeMap<&str, Value> = request.questions.iter().map(|q| {
                    let value = match &q.kind {
                        QuestionKind::Predicate => json!({"type":"noul", "instructions":q.instructions}),
                        QuestionKind::Choice { choices } => {
                            let criteria: BTreeMap<&str, &str> = choices.iter().map(|c| (c.value.as_str(), c.description.as_str())).collect();
                            json!({"type":"choice", "instructions":q.instructions, "criteria":criteria})
                        },
                        QuestionKind::Score { levels } => {
                            let criteria: Vec<&str> = levels.iter().map(|l| l.description.as_str()).collect();
                            json!({"type":"score", "instructions":q.instructions, "criteria":criteria})
                        }
                    };
                    (q.id.as_str(), value)
                }).collect();
                // Send the exact same frozen serialized package as OpenAI input.
                Ok(
                    json!({"model":self.0.model(), "state":request.context.serialized(), "questions":questions}),
                )
            }
        }
    }

    pub fn parse_response(
        &self,
        request: &DecisionRequest,
        bytes: &[u8],
    ) -> Result<DecisionResult, ProviderError> {
        request.validate()?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(ProviderError::ResponseTooLarge);
        }
        // serde_json::Value normally drops duplicate object keys. Detect them
        // recursively first, including Jev answer IDs and distribution entries.
        let unique: UniqueJson =
            serde_json::from_slice(bytes).map_err(|_| ProviderError::InvalidResponse)?;
        let envelope: Envelope =
            serde_json::from_value(unique.0).map_err(|_| ProviderError::InvalidResponse)?;
        if envelope.model.is_empty() || envelope.model.len() > 256 {
            return Err(ProviderError::InvalidResponse);
        }
        envelope.usage.validate()?;
        let mut answers = BTreeMap::new();
        match self.0 {
            ProviderKind::OpenAiResponses | ProviderKind::OpenRouterChat => {
                return Err(ProviderError::InvalidConfiguration);
            }
            ProviderKind::Jev => {
                let native: BTreeMap<String, JevAnswer> = serde_json::from_value(envelope.answers)
                    .map_err(|_| ProviderError::InvalidResponse)?;
                if native.len() != request.questions.len() {
                    return Err(ProviderError::InvalidResponse);
                }
                for q in &request.questions {
                    let answer = native.get(&q.id).ok_or(ProviderError::InvalidResponse)?;
                    answers.insert(q.id.clone(), normalize_jev(q, answer)?);
                }
            }
            ProviderKind::OpenAiDecisions => {
                let native: Vec<LunaAnswer> = serde_json::from_value(envelope.answers)
                    .map_err(|_| ProviderError::InvalidResponse)?;
                if native.len() != request.questions.len() {
                    return Err(ProviderError::InvalidResponse);
                }
                for (q, answer) in request.questions.iter().zip(native.iter()) {
                    // OpenAI guarantees request order as well as named answers.
                    if answer.name() != q.id || answers.contains_key(&q.id) {
                        return Err(ProviderError::InvalidResponse);
                    }
                    answers.insert(q.id.clone(), normalize_luna(q, answer)?);
                }
            }
        }
        Ok(DecisionResult {
            provider: self.0,
            requested_model: self.0.model().into(),
            resolved_model: envelope.model,
            context_hash: request.context.hash().into(),
            rubric_version: request.rubric_version.clone(),
            answers,
            input_tokens: envelope.usage.input_tokens,
            output_tokens: envelope.usage.output_tokens,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    model: String,
    answers: Value,
    usage: Usage,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Usage {
    input_tokens: u64,
    output_tokens: u64,
    #[serde(default)]
    input_tokens_details: Option<InputDetails>,
    #[serde(default)]
    output_tokens_details: Option<OutputDetails>,
    #[serde(default)]
    total_tokens: Option<u64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InputDetails {
    cached_tokens: u64,
    cache_write_tokens: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OutputDetails {
    reasoning_tokens: u64,
}

impl Usage {
    fn validate(&self) -> Result<(), ProviderError> {
        let total = self
            .input_tokens
            .checked_add(self.output_tokens)
            .ok_or(ProviderError::InvalidResponse)?;
        if self.total_tokens.is_some_and(|value| value != total) {
            return Err(ProviderError::InvalidResponse);
        }
        if let Some(details) = &self.input_tokens_details {
            let cached = details
                .cached_tokens
                .checked_add(details.cache_write_tokens)
                .ok_or(ProviderError::InvalidResponse)?;
            if cached > self.input_tokens {
                return Err(ProviderError::InvalidResponse);
            }
        }
        if self
            .output_tokens_details
            .as_ref()
            .is_some_and(|details| details.reasoning_tokens > self.output_tokens)
        {
            return Err(ProviderError::InvalidResponse);
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum JevAnswer {
    Noul {
        noul: f64,
    },
    Choice {
        choice: String,
        probabilities: BTreeMap<String, f64>,
        confidence: f64,
    },
    Score {
        score: f64,
        legend: BTreeMap<String, String>,
        probabilities: BTreeMap<String, f64>,
        confidence: f64,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LunaChoiceProbability {
    value: String,
    probability: f64,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum LunaAnswer {
    Predicate {
        name: String,
        probability: f64,
    },
    Choice {
        name: String,
        choice: String,
        probabilities: Vec<LunaChoiceProbability>,
        confidence: f64,
    },
    Score {
        name: String,
        score: f64,
        probabilities: Vec<ScoreProbability>,
        confidence: f64,
    },
    Refusal {
        name: String,
    },
}
impl LunaAnswer {
    fn name(&self) -> &str {
        match self {
            Self::Predicate { name, .. }
            | Self::Choice { name, .. }
            | Self::Score { name, .. }
            | Self::Refusal { name } => name,
        }
    }
}

fn probability(value: f64) -> Result<f64, ProviderError> {
    if value.is_finite() && (0.0..=1.0).contains(&value) {
        Ok(value)
    } else {
        Err(ProviderError::InvalidResponse)
    }
}
fn distribution(values: impl Iterator<Item = f64>) -> Result<(), ProviderError> {
    let mut sum = 0.0;
    for value in values {
        sum += probability(value)?;
    }
    if (sum - 1.0).abs() <= TOLERANCE {
        Ok(())
    } else {
        Err(ProviderError::InvalidResponse)
    }
}
fn choice_answer(
    choices: &[ChoiceOption],
    choice: &str,
    probabilities: Vec<ChoiceProbability>,
    confidence: f64,
) -> Result<AdvisoryAnswer, ProviderError> {
    probability(confidence)?;
    let expected: BTreeSet<&str> = choices.iter().map(|c| c.value.as_str()).collect();
    if probabilities.len() != expected.len()
        || !expected.contains(choice)
        || probabilities
            .iter()
            .map(|p| p.value.as_str())
            .collect::<BTreeSet<_>>()
            != expected
    {
        return Err(ProviderError::InvalidResponse);
    }
    distribution(probabilities.iter().map(|p| p.probability))?;
    let selected = probabilities
        .iter()
        .find(|p| p.value == choice)
        .ok_or(ProviderError::InvalidResponse)?
        .probability;
    if probabilities
        .iter()
        .any(|p| p.probability > selected + TOLERANCE)
    {
        return Err(ProviderError::InvalidResponse);
    }
    Ok(AdvisoryAnswer::Choice {
        choice: choice.into(),
        probabilities,
        native_confidence: confidence,
    })
}
fn score_answer(
    levels: &[ScoreLevel],
    score: f64,
    mut probabilities: Vec<ScoreProbability>,
    confidence: f64,
) -> Result<AdvisoryAnswer, ProviderError> {
    probability(confidence)?;
    if probabilities.len() != levels.len() {
        return Err(ProviderError::InvalidResponse);
    }
    probabilities.sort_by_key(|p| p.value);
    for (i, p) in probabilities.iter().enumerate() {
        if p.value != i as u32 || p.label != levels[i].label {
            return Err(ProviderError::InvalidResponse);
        }
    }
    distribution(probabilities.iter().map(|p| p.probability))?;
    let weighted: f64 = probabilities
        .iter()
        .map(|p| p.value as f64 * p.probability)
        .sum();
    if !score.is_finite()
        || !(0.0..=(levels.len() - 1) as f64).contains(&score)
        || (score - weighted).abs() > TOLERANCE
    {
        return Err(ProviderError::InvalidResponse);
    }
    Ok(AdvisoryAnswer::Score {
        score,
        minimum: 0,
        maximum: (levels.len() - 1) as u32,
        probabilities,
        native_confidence: confidence,
    })
}
fn normalize_jev(q: &DecisionQuestion, a: &JevAnswer) -> Result<AdvisoryAnswer, ProviderError> {
    match (&q.kind, a) {
        (QuestionKind::Predicate, JevAnswer::Noul { noul }) => Ok(AdvisoryAnswer::Predicate {
            probability: probability(*noul)?,
        }),
        (
            QuestionKind::Choice { choices },
            JevAnswer::Choice {
                choice,
                probabilities,
                confidence,
            },
        ) => choice_answer(
            choices,
            choice,
            probabilities
                .iter()
                .map(|(v, p)| ChoiceProbability {
                    value: v.clone(),
                    probability: *p,
                })
                .collect(),
            *confidence,
        ),
        (
            QuestionKind::Score { levels },
            JevAnswer::Score {
                score,
                legend,
                probabilities,
                confidence,
            },
        ) => {
            if legend.len() != levels.len() || probabilities.len() != levels.len() {
                return Err(ProviderError::InvalidResponse);
            }
            let mut normalized = Vec::new();
            for (i, level) in levels.iter().enumerate() {
                let key = i.to_string();
                if legend.get(&key) != Some(&level.description) {
                    return Err(ProviderError::InvalidResponse);
                }
                normalized.push(ScoreProbability {
                    value: i as u32,
                    label: level.label.clone(),
                    probability: *probabilities
                        .get(&key)
                        .ok_or(ProviderError::InvalidResponse)?,
                });
            }
            score_answer(levels, *score, normalized, *confidence)
        }
        _ => Err(ProviderError::InvalidResponse),
    }
}
fn normalize_luna(q: &DecisionQuestion, a: &LunaAnswer) -> Result<AdvisoryAnswer, ProviderError> {
    match (&q.kind, a) {
        (_, LunaAnswer::Refusal { .. }) => Ok(AdvisoryAnswer::Refusal),
        (QuestionKind::Predicate, LunaAnswer::Predicate { probability: p, .. }) => {
            Ok(AdvisoryAnswer::Predicate {
                probability: probability(*p)?,
            })
        }
        (
            QuestionKind::Choice { choices },
            LunaAnswer::Choice {
                choice,
                probabilities,
                confidence,
                ..
            },
        ) => choice_answer(
            choices,
            choice,
            probabilities
                .iter()
                .map(|p| ChoiceProbability {
                    value: p.value.clone(),
                    probability: p.probability,
                })
                .collect(),
            *confidence,
        ),
        (
            QuestionKind::Score { levels },
            LunaAnswer::Score {
                score,
                probabilities,
                confidence,
                ..
            },
        ) => score_answer(levels, *score, probabilities.clone(), *confidence),
        _ => Err(ProviderError::InvalidResponse),
    }
}

// Recursively preserve uniqueness, without retaining malformed bodies in errors.
pub(super) struct UniqueJson(pub(super) Value);
impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(UniqueVisitor)
    }
}
struct UniqueVisitor;
impl<'de> Visitor<'de> for UniqueVisitor {
    type Value = UniqueJson;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("JSON with unique object keys")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut object = serde_json::Map::new();
        while let Some((key, value)) = map.next_entry::<String, UniqueJson>()? {
            if object.insert(key, value.0).is_some() {
                return Err(de::Error::custom("duplicate object key"));
            }
        }
        Ok(UniqueJson(Value::Object(object)))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element::<UniqueJson>()? {
            items.push(item.0);
        }
        Ok(UniqueJson(Value::Array(items)))
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> {
        Ok(UniqueJson(v.into()))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
        Ok(UniqueJson(v.into()))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
        Ok(UniqueJson(v.into()))
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
        serde_json::Number::from_f64(v)
            .map(|n| UniqueJson(Value::Number(n)))
            .ok_or_else(|| E::custom("invalid number"))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
        Ok(UniqueJson(v.into()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
        Ok(UniqueJson(v.into()))
    }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(UniqueJson(Value::Null))
    }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(UniqueJson(Value::Null))
    }
}

/// Synthetic fixtures cannot be enabled in a production build.
#[cfg(test)]
pub struct FixtureDecisionProvider {
    pub kind: ProviderKind,
    pub response: Vec<u8>,
}
#[cfg(test)]
#[async_trait]
impl DecisionProvider for FixtureDecisionProvider {
    async fn evaluate(&self, request: &DecisionRequest) -> Result<DecisionResult, ProviderError> {
        DecisionCodec(self.kind).request_body(request)?;
        DecisionCodec(self.kind).parse_response(request, &self.response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> DecisionRequest {
        DecisionRequest {
            context: FrozenProviderContext::freeze(br#"{"context_policy":"direct_parent_v1","prompt":"Inspect the error rate","parent_export":{"answer":"Only direct parent evidence"}}"#, "synthetic-hash").unwrap(),
            questions: vec![
                DecisionQuestion { id:"urgent".into(), instructions:"Does the evidence indicate urgency?".into(), kind:QuestionKind::Predicate },
                DecisionQuestion { id:"category".into(), instructions:"Classify the evidence.".into(), kind:QuestionKind::Choice { choices:vec![
                    ChoiceOption {value:"error".into(), description:"Errors observed".into()},
                    ChoiceOption {value:"normal".into(), description:"Normal operation".into()},
                ] } },
                DecisionQuestion { id:"severity".into(), instructions:"Rate severity.".into(), kind:QuestionKind::Score { levels:vec![
                    ScoreLevel {label:"low".into(), description:"Low severity".into()},
                    ScoreLevel {label:"high".into(), description:"High severity".into()},
                ] } },
            ], rubric_version:"fixture_v1".into(),
        }
    }
    fn jev_response() -> Value {
        json!({"model":"jev-1.13.0", "answers":{
            "urgent":{"type":"noul","noul":0.75},
            "category":{"type":"choice","choice":"error","confidence":0.55,"probabilities":{"error":0.8,"normal":0.2}},
            "severity":{"type":"score","score":0.25,"confidence":0.4,"legend":{"0":"Low severity","1":"High severity"},"probabilities":{"0":0.75,"1":0.25}}
        }, "usage":{"input_tokens":42,"output_tokens":8}})
    }
    fn luna_response() -> Value {
        json!({"model":"gpt-6-luna", "answers":[
            {"type":"predicate","name":"urgent","probability":0.75},
            {"type":"choice","name":"category","choice":"error","confidence":0.55,"probabilities":[{"value":"error","probability":0.8},{"value":"normal","probability":0.2}]},
            {"type":"score","name":"severity","score":0.25,"confidence":0.4,"probabilities":[{"value":0,"label":"low","probability":0.75},{"value":1,"label":"high","probability":0.25}]}
        ], "usage":{"input_tokens":42,"output_tokens":0,"input_tokens_details":{"cached_tokens":0,"cache_write_tokens":0},"output_tokens_details":{"reasoning_tokens":0},"total_tokens":42}})
    }
    fn parse(kind: ProviderKind, response: Value) -> Result<DecisionResult, ProviderError> {
        DecisionCodec(kind).parse_response(&request(), &serde_json::to_vec(&response).unwrap())
    }

    #[test]
    fn exact_stateless_request_payloads() {
        let req = request();
        let jev = DecisionCodec(ProviderKind::Jev).request_body(&req).unwrap();
        assert_eq!(
            jev,
            json!({"model":"jev-1.13.0", "state":req.context.serialized(), "questions":{
                "urgent":{"type":"noul","instructions":"Does the evidence indicate urgency?"},
                "category":{"type":"choice","instructions":"Classify the evidence.","criteria":{"error":"Errors observed","normal":"Normal operation"}},
                "severity":{"type":"score","instructions":"Rate severity.","criteria":["Low severity","High severity"]}
            }})
        );
        let luna = DecisionCodec(ProviderKind::OpenAiDecisions)
            .request_body(&req)
            .unwrap();
        assert_eq!(
            luna,
            json!({"model":"gpt-6-luna","input":req.context.serialized(),"questions":[
                {"type":"predicate","name":"urgent","instructions":"Does the evidence indicate urgency?"},
                {"type":"choice","name":"category","instructions":"Classify the evidence.","choices":[{"value":"error","description":"Errors observed"},{"value":"normal","description":"Normal operation"}]},
                {"type":"score","name":"severity","instructions":"Rate severity.","levels":[{"label":"low","description":"Low severity"},{"label":"high","description":"High severity"}]}
            ]})
        );
        for payload in [jev, luna] {
            let object = payload.as_object().unwrap();
            for key in [
                "conversation",
                "previous_response_id",
                "session",
                "session_id",
                "tools",
                "scope",
                "authorization",
                "context_hash",
            ] {
                assert!(!object.contains_key(key));
            }
        }
        assert!(!format!("{req:?} {:?}", req.context).contains("Only direct parent evidence"));
    }

    #[test]
    fn fractional_scores_native_confidence_and_refusal_are_preserved() {
        for (kind, response) in [
            (ProviderKind::Jev, jev_response()),
            (ProviderKind::OpenAiDecisions, luna_response()),
        ] {
            let result = parse(kind, response).unwrap();
            assert_eq!(
                result.answers["urgent"],
                AdvisoryAnswer::Predicate { probability: 0.75 }
            );
            match &result.answers["severity"] {
                AdvisoryAnswer::Score {
                    score,
                    minimum,
                    maximum,
                    native_confidence,
                    ..
                } => {
                    assert_eq!(
                        (*score, *minimum, *maximum, *native_confidence),
                        (0.25, 0, 1, 0.4)
                    );
                }
                _ => panic!("wrong native score type"),
            }
            match &result.answers["category"] {
                AdvisoryAnswer::Choice {
                    native_confidence,
                    probabilities,
                    ..
                } => {
                    assert_eq!(*native_confidence, 0.55);
                    assert_eq!(
                        probabilities
                            .iter()
                            .find(|p| p.value == "error")
                            .unwrap()
                            .probability,
                        0.8
                    );
                }
                _ => panic!("wrong native choice type"),
            }
        }
        let mut response = luna_response();
        response["answers"][1] = json!({"type":"refusal","name":"category"});
        let result = parse(ProviderKind::OpenAiDecisions, response).unwrap();
        assert_eq!(result.answers["category"], AdvisoryAnswer::Refusal);
        assert!(matches!(
            result.answers["urgent"],
            AdvisoryAnswer::Predicate { .. }
        ));
    }

    #[test]
    fn malformed_missing_unexpected_duplicate_and_wrong_type_answers_rejected() {
        let mut broken = Vec::new();
        let response = luna_response();
        let mut missing = response.clone();
        missing["answers"].as_array_mut().unwrap().pop();
        broken.push(missing);
        let mut duplicate = response.clone();
        duplicate["answers"][1]["name"] = json!("urgent");
        broken.push(duplicate);
        let mut unknown = response.clone();
        unknown["answers"][1]["name"] = json!("unexpected");
        broken.push(unknown);
        let mut null = response.clone();
        null["answers"][1]["name"] = Value::Null;
        broken.push(null);
        let mut range = response.clone();
        range["answers"][0]["probability"] = json!(1.1);
        broken.push(range);
        let mut confidence = response.clone();
        confidence["answers"][1]["confidence"] = json!(-0.1);
        broken.push(confidence);
        let mut bool_choice = response.clone();
        bool_choice["answers"][1]["choice"] = json!(true);
        broken.push(bool_choice);
        let mut extra_distribution = response.clone();
        extra_distribution["answers"][1]["probabilities"]
            .as_array_mut()
            .unwrap()
            .push(json!({"value":"error","probability":0}));
        broken.push(extra_distribution);
        let mut wrong_sum = response.clone();
        wrong_sum["answers"][1]["probabilities"][0]["probability"] = json!(0.1);
        broken.push(wrong_sum);
        let mut wrong_weight = response.clone();
        wrong_weight["answers"][2]["score"] = json!(0.5);
        broken.push(wrong_weight);
        let mut wrong_scale = response.clone();
        wrong_scale["answers"][2]["probabilities"][1]["value"] = json!(2);
        broken.push(wrong_scale);
        let mut wrong_label = response.clone();
        wrong_label["answers"][2]["probabilities"][1]["label"] = json!("other");
        broken.push(wrong_label);
        let mut negative_usage = response.clone();
        negative_usage["usage"]["input_tokens"] = json!(-1);
        broken.push(negative_usage);
        for field in ["sql", "tool_call", "scope", "execute"] {
            let mut injected = response.clone();
            injected["answers"][0][field] = json!("SELECT * FROM secret");
            broken.push(injected);
        }
        for value in broken {
            assert_eq!(
                parse(ProviderKind::OpenAiDecisions, value),
                Err(ProviderError::InvalidResponse)
            );
        }
        let mut jev = jev_response();
        jev["answers"]["urgent"] = json!({"type":"refusal"});
        assert!(parse(ProviderKind::Jev, jev).is_err());
        let mut jev = jev_response();
        jev["answers"]["severity"]["legend"]["1"] = json!("Changed rubric");
        assert!(parse(ProviderKind::Jev, jev).is_err());
        let duplicate_jev=br#"{"model":"jev-1.13.0","answers":{"urgent":{"type":"noul","noul":0.5},"urgent":{"type":"noul","noul":0.6}},"usage":{"input_tokens":1,"output_tokens":1}}"#;
        assert!(
            DecisionCodec(ProviderKind::Jev)
                .parse_response(&request(), duplicate_jev)
                .is_err()
        );
        assert!(
            DecisionCodec(ProviderKind::Jev)
                .parse_response(&request(), b"invalid-json")
                .is_err()
        );
        assert_eq!(
            DecisionCodec(ProviderKind::Jev)
                .parse_response(&request(), &vec![b' '; MAX_RESPONSE_BYTES + 1]),
            Err(ProviderError::ResponseTooLarge)
        );
    }

    #[test]
    fn unique_and_bounded_closed_rubrics() {
        let mut req = request();
        req.questions[1].id = req.questions[0].id.clone();
        assert!(req.validate().is_err());
        let mut req = request();
        req.questions[0].instructions = "x".repeat(MAX_RUBRIC_BYTES);
        assert!(req.validate().is_err());
        let mut req = request();
        req.questions[0].id = "../scope".into();
        assert!(req.validate().is_err());
        let mut req = request();
        req.questions.clear();
        assert!(req.validate().is_err());
    }

    #[tokio::test]
    async fn production_fails_closed_and_fixture_remains_advisory() {
        assert_eq!(
            UnavailableDecisionProvider.evaluate(&request()).await,
            Err(ProviderError::ProductionUnavailable)
        );
        let provider = FixtureDecisionProvider {
            kind: ProviderKind::OpenAiDecisions,
            response: serde_json::to_vec(&luna_response()).unwrap(),
        };
        assert_eq!(
            provider.evaluate(&request()).await.unwrap().answers.len(),
            3
        );
        assert!(!super::super::capabilities().credential_entry_available);
        assert!(!super::super::capabilities().decision_available);
    }
}
