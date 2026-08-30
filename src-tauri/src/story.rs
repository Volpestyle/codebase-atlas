//! The narrative layer: a hand-authored `.codebase-index/_story.json` naming
//! the actors a reader would recognize, what travels between them, and the
//! journeys data takes end to end.
//!
//! Nothing here is derived. Imports say which file needs which; only prose can
//! say that a message arrives from Discord, or that the model writes the words.
//! The scanner's job is to validate the file against the tree it just scanned
//! and to report where the two disagree, not to guess the story.

use std::{collections::BTreeSet, fs, path::Path};

use serde::{Deserialize, Serialize};

/// The file is small and hand-written; a runaway one is a mistake, not a repo.
const MAX_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Story {
    /// What this repository is, in a paragraph a non-programmer can read.
    pub summary: String,
    pub actors: Vec<Actor>,
    pub flows: Vec<Flow>,
    #[serde(default)]
    pub journeys: Vec<Journey>,
}

/// Where an actor sits in the telling. The role is also the column, which is
/// why the set is ordered rather than descriptive: people, the surfaces they
/// meet, the one entrance that checks them, what decides, what is kept, and
/// the outside systems called. A story needs no layout because naming a role
/// honestly already places it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ActorRole {
    Person,
    Surface,
    Door,
    Core,
    Store,
    External,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Actor {
    pub id: String,
    pub name: String,
    pub role: ActorRole,
    pub blurb: String,
    /// Scanned paths this actor is made of. An actor is a role, not a
    /// directory, so several modules can serve one and some actors (a person,
    /// an outside service) have none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modules: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Flow {
    pub from: String,
    pub to: String,
    /// What travels, in words: "a message someone typed", not "MessageEvent".
    pub carries: String,
    /// What comes back, when anything does. One drawn arrow carries both
    /// directions so a round trip does not double every line on the diagram.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub returns: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Journey {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blurb: Option<String>,
    /// Actor ids in the order data visits them. Consecutive pairs must have a
    /// flow between them in one direction or the other; a step against a flow
    /// reads as its `returns`.
    pub steps: Vec<String>,
}

/// Reads the story beside a scanned repository, if one is there. Problems are
/// reported as scan warnings and the offending piece is dropped, so a story
/// that has drifted from the code still renders the part that is true.
pub(crate) fn attach_story(
    root: &Path,
    node_ids: &BTreeSet<&str>,
    warnings: &mut Vec<String>,
) -> Option<Story> {
    let path = root.join(".codebase-index/_story.json");
    if !path.is_file() {
        return None;
    }
    match fs::metadata(&path) {
        Ok(metadata) if metadata.len() > MAX_BYTES => {
            warnings.push("The story file is too large to read.".to_owned());
            return None;
        }
        Err(_) => {
            warnings.push("Could not read the story file.".to_owned());
            return None;
        }
        _ => {}
    }
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => {
            warnings.push("Could not read the story file.".to_owned());
            return None;
        }
    };
    let mut story: Story = match serde_json::from_str(&text) {
        Ok(story) => story,
        Err(error) => {
            warnings.push(format!("The story file could not be read: {error}."));
            return None;
        }
    };
    validate(&mut story, node_ids, warnings);
    (!story.actors.is_empty()).then_some(story)
}

/// Drops what the scanned tree does not support and says so. A dangling actor
/// id or a module path that has since been renamed is the expected failure of
/// a hand-written file, so each one is named rather than silently ignored.
fn validate(story: &mut Story, node_ids: &BTreeSet<&str>, warnings: &mut Vec<String>) {
    let mut seen = BTreeSet::new();
    story.actors.retain(|actor| {
        if !seen.insert(actor.id.clone()) {
            warnings.push(format!("Story: actor \"{}\" is defined twice.", actor.id));
            return false;
        }
        true
    });

    let mut unknown_modules = Vec::new();
    for actor in &mut story.actors {
        actor.modules.retain(|module| {
            if node_ids.contains(module.as_str()) {
                return true;
            }
            unknown_modules.push(module.clone());
            false
        });
    }
    if !unknown_modules.is_empty() {
        warnings.push(format!(
            "Story: {} path(s) are not in this repository and were dropped: {}.",
            unknown_modules.len(),
            unknown_modules.join(", ")
        ));
    }

    let actors: BTreeSet<&str> = story.actors.iter().map(|actor| actor.id.as_str()).collect();
    let mut dangling = 0;
    story.flows.retain(|flow| {
        let known = actors.contains(flow.from.as_str()) && actors.contains(flow.to.as_str());
        if !known {
            dangling += 1;
        }
        known
    });
    if dangling > 0 {
        warnings.push(format!(
            "Story: {dangling} flow(s) name an actor the story does not define."
        ));
    }

    let connected: BTreeSet<(&str, &str)> = story
        .flows
        .iter()
        .flat_map(|flow| {
            [
                (flow.from.as_str(), flow.to.as_str()),
                (flow.to.as_str(), flow.from.as_str()),
            ]
        })
        .collect();
    story.journeys.retain(|journey| {
        let broken = journey.steps.windows(2).find(|pair| {
            !connected.contains(&(pair[0].as_str(), pair[1].as_str()))
        });
        match broken {
            Some(pair) => {
                warnings.push(format!(
                    "Story: journey \"{}\" has no flow from {} to {}.",
                    journey.name, pair[0], pair[1]
                ));
                false
            }
            None => journey.steps.len() >= 2,
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, body: &str) {
        fs::create_dir_all(root.join(".codebase-index")).expect("create index directory");
        fs::write(root.join(".codebase-index/_story.json"), body).expect("write story");
    }

    fn ids<'a>(values: &'a [&'a str]) -> BTreeSet<&'a str> {
        values.iter().copied().collect()
    }

    const GOOD: &str = r#"{
      "summary": "A tiny thing.",
      "actors": [
        {"id":"user","name":"A person","role":"person","blurb":"Types."},
        {"id":"api","name":"The door","role":"door","blurb":"Listens.","modules":["web"]},
        {"id":"brain","name":"The mind","role":"core","blurb":"Decides.","modules":["gone"]}
      ],
      "flows": [
        {"from":"user","to":"api","carries":"a request","returns":"an answer"},
        {"from":"api","to":"brain","carries":"the work"}
      ],
      "journeys": [{"name":"Ask","steps":["user","api","brain","api","user"]}]
    }"#;

    #[test]
    fn reads_a_story_and_drops_paths_the_scan_does_not_have() {
        let root = tempfile::tempdir().expect("temp dir");
        write(root.path(), GOOD);
        let mut warnings = Vec::new();
        let story =
            attach_story(root.path(), &ids(&[".", "web"]), &mut warnings).expect("story parsed");

        assert_eq!(story.actors.len(), 3);
        assert_eq!(story.actors[1].modules, vec!["web".to_owned()]);
        // "gone" was renamed away from the story's reference.
        assert!(story.actors[2].modules.is_empty());
        assert!(warnings.iter().any(|warning| warning.contains("gone")));
        // A journey may walk a flow backwards; that reads as its return.
        assert_eq!(story.journeys.len(), 1);
    }

    #[test]
    fn drops_a_journey_that_takes_a_step_no_flow_supports() {
        let root = tempfile::tempdir().expect("temp dir");
        write(
            root.path(),
            &GOOD.replace(r#"["user","api","brain","api","user"]"#, r#"["user","brain"]"#),
        );
        let mut warnings = Vec::new();
        let story = attach_story(root.path(), &ids(&["."]), &mut warnings).expect("story parsed");

        assert!(story.journeys.is_empty());
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("no flow from user to brain")));
    }

    #[test]
    fn a_repository_without_a_story_is_not_a_warning() {
        let root = tempfile::tempdir().expect("temp dir");
        let mut warnings = Vec::new();
        assert!(attach_story(root.path(), &ids(&["."]), &mut warnings).is_none());
        assert!(warnings.is_empty());
    }

    #[test]
    fn malformed_json_warns_instead_of_failing_the_scan() {
        let root = tempfile::tempdir().expect("temp dir");
        write(root.path(), "{ not json");
        let mut warnings = Vec::new();
        assert!(attach_story(root.path(), &ids(&["."]), &mut warnings).is_none());
        assert_eq!(warnings.len(), 1);
    }
}
