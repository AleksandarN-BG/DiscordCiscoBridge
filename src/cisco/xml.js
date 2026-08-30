// Builders for the CiscoIPPhone* XML documents the phone renders.
//
// Every one of these is a pure function: give it data, get a string. Nothing
// here knows about Express, Discord, or the running session, which is what
// makes the route handlers readable and these testable.
//
// Escaping happens here and only here. Callers pass raw strings -- including
// URLs, whose query separators must reach the phone as `&amp;`. Escaping at
// the boundary rather than at each call site is what fixes the old double-
// escape: `_safeXmlName()` used to escape a name, then `/status` escaped the
// whole page again, so a user called `A&B` displayed as `A&amp;B`.

const ENTITIES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };

const DECLARATION = '<?xml version="1.0"?>';

/** Escape the five XML predefined entities. Applied once, at emit time. */
function escape(str) {
  return String(str ?? '').replace(/[<>&"']/g, (c) => ENTITIES[c]);
}

/**
 * Reduce a Discord name to something a 8845's menu row can actually show:
 * ASCII only (the phone renders nothing else), trimmed, and clamped.
 *
 * Deliberately does NOT escape -- the builders do that. Escaping here was the
 * source of the double-escape bug.
 */
function displayName(str, max = 14) {
  return String(str ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .slice(0, max);
}

/**
 * A selectable list.
 * @param {{title: string, prompt?: string, items: Array<{name: string, url: string}>}} spec
 */
function menu({ title, prompt, items }) {
  const rows = items.map(
    ({ name, url }) => `<MenuItem><Name>${escape(name)}</Name><URL>${escape(url)}</URL></MenuItem>`,
  );

  return [
    DECLARATION,
    '<CiscoIPPhoneMenu>',
    `<Title>${escape(title)}</Title>`,
    ...(prompt ? [`<Prompt>${escape(prompt)}</Prompt>`] : []),
    ...rows,
    '</CiscoIPPhoneMenu>',
  ].join('\n');
}

/**
 * A text page with optional soft keys. Soft-key positions are assigned in
 * order, because the phone requires them to be contiguous from 1.
 * @param {{title: string, body: string, softKeys?: Array<{name: string, url: string}>}} spec
 */
function textPage({ title, body, softKeys = [] }) {
  const keys = softKeys.flatMap(({ name, url }, i) => [
    '<SoftKeyItem>',
    `<Name>${escape(name)}</Name>`,
    `<URL>${escape(url)}</URL>`,
    `<Position>${i + 1}</Position>`,
    '</SoftKeyItem>',
  ]);

  return [
    DECLARATION,
    '<CiscoIPPhoneText>',
    `<Title>${escape(title)}</Title>`,
    `<Text>${escape(body)}</Text>`,
    ...keys,
    '</CiscoIPPhoneText>',
  ].join('\n');
}

/** An execute document, used to push the phone back to its idle screen. */
function execute(url) {
  return `${DECLARATION}\n<CiscoIPPhoneExecute><ExecuteItem URL="${escape(url)}"/></CiscoIPPhoneExecute>`;
}

module.exports = { escape, displayName, menu, textPage, execute };
