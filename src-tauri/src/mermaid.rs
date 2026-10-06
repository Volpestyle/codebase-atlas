//! Mermaid is an export of the written story, never the interactive renderer.
use crate::story::{ActorRole, Story};
use std::{fmt::Write, path::Path};

const INIT: &str = r##"%%{init: {"theme":"base","themeVariables":{"fontFamily":"Geist, system-ui, sans-serif","fontSize":"13px","primaryColor":"#ffffff","primaryTextColor":"#0a0a0a","primaryBorderColor":"#8a8a8a","lineColor":"#8a8a8a","secondaryColor":"#f4f4f4","tertiaryColor":"#ffffff","actorBkg":"#ffffff","actorBorder":"#8a8a8a","actorTextColor":"#0a0a0a","signalColor":"#0a0a0a","signalTextColor":"#404040"},"flowchart":{"htmlLabels":false},"sequence":{"mirrorActors":false}}}%%"##;
const ROLES: &[(ActorRole, &str)] = &[
    (ActorRole::Person, "People"),
    (ActorRole::Surface, "Where they arrive"),
    (ActorRole::Door, "The way in"),
    (ActorRole::Core, "What decides"),
    (ActorRole::Store, "What it keeps"),
    (ActorRole::External, "Outside services"),
];

fn text(value: &str) -> String {
    let normalized = value
        .split(|c: char| c.is_whitespace() || c == '\u{feff}')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let chars = normalized.chars().collect::<Vec<_>>();
    let mut output = String::new();
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
        if chars[index..].starts_with(&['e', 'n', 'd'])
            && (index == 0 || !word(chars[index - 1]))
            && (index + 3 == chars.len() || !word(chars[index + 3]))
        {
            output.push_str("#101;nd");
            index += 3;
            continue;
        }
        if c.is_ascii_alphanumeric() || " ,.'?!-".contains(c) {
            output.push(c);
        } else {
            write!(output, "#{};", u32::from(c)).expect("write string");
        }
        index += 1;
    }
    output
}

fn select(story: &Story, selector: &str) -> Result<usize, String> {
    if let Some(index) = story
        .journeys
        .iter()
        .position(|journey| journey.name == selector)
    {
        return Ok(index);
    }
    if selector.bytes().all(|byte| byte.is_ascii_digit()) {
        if let Some(index) = selector
            .parse::<usize>()
            .ok()
            .and_then(|number| number.checked_sub(1))
        {
            if index < story.journeys.len() {
                return Ok(index);
            }
        }
    }
    Err(format!(
        "Journey not found: {selector}. Use its exact name or a 1-based index."
    ))
}

fn format(story: &Story, selected: Option<usize>) -> String {
    let mut output = format!("{INIT}\n");
    let id = |value: &str| {
        story
            .actors
            .iter()
            .position(|actor| actor.id == value)
            .map(|index| format!("a{index}"))
    };
    if let Some(index) = selected {
        let journey = &story.journeys[index];
        output.push_str("sequenceDiagram\n");
        let mut seen = std::collections::BTreeSet::new();
        for actor_id in &journey.steps {
            if !seen.insert(actor_id) {
                continue;
            }
            if let Some(actor) = story.actors.iter().find(|actor| &actor.id == actor_id) {
                writeln!(
                    output,
                    "  participant {} as {}",
                    id(actor_id).unwrap(),
                    text(&actor.name)
                )
                .expect("write string");
            }
        }
        for pair in journey.steps.windows(2) {
            let (from, to) = (&pair[0], &pair[1]);
            let flow = story
                .flows
                .iter()
                .find(|flow| &flow.from == from && &flow.to == to)
                .map(|flow| (flow, false))
                .or_else(|| {
                    story
                        .flows
                        .iter()
                        .find(|flow| &flow.to == from && &flow.from == to)
                        .map(|flow| (flow, true))
                });
            if let (Some((flow, reverse)), Some(from), Some(to)) = (flow, id(from), id(to)) {
                let message = if reverse {
                    flow.returns.as_ref().unwrap_or(&flow.carries)
                } else {
                    &flow.carries
                };
                writeln!(
                    output,
                    "  {from}{}{to}: {}",
                    if reverse { "-->>" } else { "->>" },
                    text(message)
                )
                .expect("write string");
            }
        }
    } else {
        output.push_str("flowchart LR\n");
        for (index, &(role, heading)) in ROLES.iter().enumerate() {
            let actors = story
                .actors
                .iter()
                .filter(|actor| actor.role == role)
                .collect::<Vec<_>>();
            if actors.is_empty() {
                continue;
            }
            writeln!(
                output,
                "  subgraph role{index}[\"{heading}\"]\n    direction TB"
            )
            .expect("write string");
            for actor in actors {
                writeln!(
                    output,
                    "    {}[\"{}\"]",
                    id(&actor.id).unwrap(),
                    text(&actor.name)
                )
                .expect("write string");
            }
            output.push_str("  end\n");
        }
        for flow in &story.flows {
            if let (Some(from), Some(to)) = (id(&flow.from), id(&flow.to)) {
                writeln!(output, "  {from} -->|\"{}\"| {to}", text(&flow.carries))
                    .expect("write string");
            }
        }
    }
    output
}

/// Exports a freshly validated story, selecting a journey by exact name or 1-based index.
///
/// # Errors
/// Refuses unusable stories, story warnings, missing repositories and unknown journeys.
pub fn story_mermaid(repository: &Path, journey: Option<&str>) -> Result<String, String> {
    let graph = crate::scan(repository)?;
    if !graph.story_warnings.is_empty() {
        return Err(graph.story_warnings.join("\n"));
    }
    let story = graph
        .story
        .ok_or_else(|| "No usable story exists at .codebase-index/_story.json.".to_owned())?;
    let selected = journey
        .map(|selector| select(&story, selector))
        .transpose()?;
    Ok(format(&story, selected))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_shared_fixture_in_both_modes() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/mermaid-fixture.json")).unwrap();
        let story: Story = serde_json::from_value(fixture["story"].clone()).unwrap();
        assert_eq!(format(&story, None), fixture["flowchart"].as_str().unwrap());
        assert_eq!(
            format(&story, Some(0)),
            fixture["sequence"].as_str().unwrap()
        );
        assert_eq!(select(&story, "1").unwrap(), 0);
        assert_eq!(select(&story, &story.journeys[0].name).unwrap(), 0);
        for invalid in ["0", "2", "missing", "99999999999999999999999"] {
            assert!(select(&story, invalid).is_err());
        }
    }
}
