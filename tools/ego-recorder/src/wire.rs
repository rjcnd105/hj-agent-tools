//! Native messaging protocol. The extension's TypeScript is generated from these types.

use crate::flow::{FieldKind, Storage};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Target {
    pub tag: String,
    pub role: Option<String>,
    pub name: Option<String>,
    pub label: Option<String>,
    pub text: Option<String>,
    pub id: Option<String>,
    pub name_attr: Option<String>,
    pub input_type: Option<String>,
    pub autocomplete: Option<String>,
    pub placeholder: Option<String>,
    pub testid: Option<String>,
    pub css: String,
    pub frame_url: String,
    pub unique: Unique,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Unique {
    pub testid: bool,
    pub role: bool,
    pub id: bool,
    pub name_attr: bool,
    pub label: bool,
    pub css: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    Click,
    Input,
    Change,
    Submit,
    Key,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HiddenField {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ActionEvent {
    pub t: f64,
    pub tab: i32,
    pub kind: ActionKind,
    pub target: Target,
    pub value: Option<String>,
    pub key: Option<String>,
    pub hidden: Vec<HiddenField>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct NavEvent {
    pub t: f64,
    pub tab: i32,
    pub url: String,
    pub transition: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct NetEvent {
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
    pub body: Option<String>,
    pub body_base64: bool,
    pub truncated: bool,
    pub failed: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CaptureEvent {
    Action(ActionEvent),
    Nav(NavEvent),
    Net(NetEvent),
    Shot {
        t: f64,
        tab: i32,
        jpeg_base64: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    Start {
        tab_url: String,
        title: String,
    },
    Events {
        events: Vec<CaptureEvent>,
    },
    Stop {
        goal: Option<String>,
    },
    List,
    Prompt {
        rec: String,
    },
    Delete {
        rec: String,
    },
    InputStatus {
        rec: String,
    },
    SetInput {
        rec: String,
        key: String,
        value: String,
        persist: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Envelope {
    pub id: u32,
    pub request: Request,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct InputField {
    pub key: String,
    pub kind: FieldKind,
    pub label: String,
    pub storage: Storage,
    pub present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RecordingSummary {
    pub id: String,
    pub title: String,
    pub created_at: f64,
    pub steps: u32,
    pub recording: bool,
    pub inputs: Vec<InputField>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReplyBody {
    Started { rec: String },
    Stopped { rec: String, steps: u32 },
    Recordings { items: Vec<RecordingSummary> },
    Prompt { text: String },
    Inputs { fields: Vec<InputField> },
    Ok,
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Reply {
    pub id: u32,
    pub reply: ReplyBody,
}
