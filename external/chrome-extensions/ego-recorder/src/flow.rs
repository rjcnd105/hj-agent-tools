//! Agent-facing recording model, and the events it derives from.

use crate::wire::{ActionEvent, NavEvent};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const SCHEMA: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meta {
    pub id: String,
    pub title: String,
    pub goal: Option<String>,
    pub start_url: String,
    pub scope: String,
    pub created_at: f64,
    pub schema: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum FieldKind {
    Username,
    Password,
    CardNumber,
    CardExp,
    CardName,
    CardCvc,
    CardPin,
    Otp,
    Plain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum Storage {
    Keychain,
    Ask,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum When {
    Start,
    Step,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InputSpec {
    pub key: String,
    pub kind: FieldKind,
    pub label: String,
    pub when: When,
    pub storage: Storage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Param {
    pub name: String,
    pub label: String,
    pub recorded_value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    Goto,
    Click,
    Fill,
    Select,
    Press,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StepValue {
    Secret(String),
    Param(String),
    Literal(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Expect {
    Url(String),
    Response {
        id: String,
        method: String,
        url: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Step {
    pub n: u32,
    pub kind: StepKind,
    pub tab: u32,
    pub locators: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<StepValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expect: Option<Expect>,
    pub api: Vec<String>,
    pub at_most_once: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shot: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Dep {
    pub field: String,
    pub from: DepSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DepSource {
    pub id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ApiCall {
    pub id: String,
    pub step: u32,
    pub method: String,
    pub url_template: String,
    pub status: Option<u16>,
    pub top: bool,
    pub req_shape: Option<String>,
    pub res_shape: Option<String>,
    pub deps: Vec<Dep>,
}

/// Steps a logged-in profile may skip: from the first login fill through its submit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LoginBlock {
    pub from: u32,
    pub to: u32,
    pub post_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Flow {
    pub schema: u32,
    pub rec: String,
    pub title: String,
    pub goal: Option<String>,
    pub start_url: String,
    pub scope: String,
    pub inputs: Vec<InputSpec>,
    pub params: Vec<Param>,
    pub steps: Vec<Step>,
    pub api: Vec<ApiCall>,
    pub login: Option<LoginBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredNet {
    pub id: String,
    pub seq: u64,
    pub t: f64,
    pub tab: i32,
    pub top: bool,
    pub method: String,
    pub url: String,
    pub resource_type: String,
    pub req_headers: Vec<(String, String)>,
    pub post_data: Option<String>,
    pub status: Option<u16>,
    pub mime: Option<String>,
    pub res_headers: Vec<(String, String)>,
    pub blob: Option<String>,
    pub truncated: bool,
    pub failed: Option<String>,
    pub req_shape: Option<String>,
    pub res_shape: Option<String>,
    pub deps: Vec<Dep>,
}

/// One line of events.ndjson.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Stored {
    Action { seq: u64, event: ActionEvent },
    Nav { seq: u64, event: NavEvent },
    Net(StoredNet),
}

impl Stored {
    pub fn t(&self) -> f64 {
        match self {
            Stored::Action { event, .. } => event.t,
            Stored::Nav { event, .. } => event.t,
            Stored::Net(net) => net.t,
        }
    }
}
