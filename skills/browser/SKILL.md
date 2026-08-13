---
name: browser
description: Operate a real, process-isolated Chrome instance via mcp__plugin_warranted_browser__* tools safely and deterministically.
---

# Browser Skill

You are operating a real Chrome browser via the `mcp__plugin_warranted_browser__*` tools. Follow these rules strictly.

> **CRITICAL**: `mcp__plugin_warranted_browser__*` are MCP tools, NOT bash commands. Never use `which`, `command -v`, or any shell check to test their availability. Call them directly.

## Core Workflow

### 0. Opening the browser

You MUST call `mcp__plugin_warranted_browser__browser_open` before any other tool. Each call spawns its own isolated chrome-devtools-mcp process (its own Chrome, its own temp profile) and returns a `session_id`. You MUST pass this `session_id` as `_browser_session` to every subsequent browser tool call — sessions are process-isolated, so one session crashing or navigating away never affects another.

```
mcp__plugin_warranted_browser__browser_open()
→ "Browser opened. Session: <uuid>"
```

Then use the returned session ID for all subsequent calls:
```
mcp__plugin_warranted_browser__navigate_page(type="url", url="https://example.com", _browser_session="<uuid>")
mcp__plugin_warranted_browser__take_screenshot(_browser_session="<uuid>")
```

Close the session when done — this kills that session's Chrome process:
```
mcp__plugin_warranted_browser__browser_close(session_id="<uuid>")
```

### Navigating to a known URL
```
mcp__plugin_warranted_browser__navigate_page(type="url", url="https://example.com", _browser_session="<uuid>")
```

### Clicking a link or button
Never fabricate or guess URLs. Always:
1. Call `mcp__plugin_warranted_browser__take_snapshot` to get the accessibility tree.
2. Find the element's `uid` in snapshot output (`uid=X_Y`).
3. Call `mcp__plugin_warranted_browser__click(uid="X_Y", _browser_session="<uuid>")`.

### Reading page content
- Visual check: `take_screenshot` (preferred for multimodal reasoning)
- Structure and links: `take_snapshot`
- Console/network state: `list_console_messages`, `list_network_requests`

### Filling forms
1. `take_snapshot` to find input uid.
2. `fill(uid="X_Y", value="text", _browser_session="<uuid>")`
3. `press_key(key="Enter", _browser_session="<uuid>")` or click submit.

### Waiting for load
```
mcp__plugin_warranted_browser__wait_for(text=["Expected text on page"], _browser_session="<uuid>")
```

### Downloading files
Prefer `wget`/`curl` once you've discovered the real file URL from the page, network activity, or page state. Only fall back to clicking a download button/link when the URL can't be recovered directly — click-driven downloads may stall on a confirmation dialog that needs human action.

## Tool categories (from upstream chrome-devtools-mcp)

Every tool besides `browser_open`/`browser_close` is proxied straight through to chrome-devtools-mcp — same names, same schemas, plus the required `_browser_session` param. Rough map:

- **Input automation**: `click`, `drag`, `fill`, `fill_form`, `handle_dialog`, `hover`, `press_key`, `type_text`, `upload_file`
- **Navigation**: `list_pages`, `new_page`, `select_page`, `close_page`, `navigate_page`, `wait_for`
- **Emulation**: `emulate`, `resize_page`
- **Debugging**: `take_screenshot`, `take_snapshot`, `evaluate_script`, `list_console_messages`, `get_console_message`, `lighthouse_audit`
- **Network**: `list_network_requests`, `get_network_request`
- **Performance**: `performance_start_trace`, `performance_stop_trace`, `performance_analyze_insight`
- **Memory**: `take_heapsnapshot` + heapsnapshot analysis tools

If a tool isn't listed here, it's still available — check the live tool list, don't assume something is missing.

## Standard Loop

1. **Open**: `browser_open` (if no session yet)
2. **Navigate**: `navigate_page` or `click`
3. **Check**: `take_screenshot`
4. **Interact**: if needed, `take_snapshot` → find uid → `click`/`fill`
5. **Repeat**

## Multi-tab (within one session)

- `list_pages`
- `new_page(url="...")`
- `select_page(pageId=N)`

Multi-tab tools operate on the ONE Chrome process belonging to `_browser_session`. Don't confuse this with opening a second session — use a second `browser_open()` only when you actually need a second, fully independent Chrome process (e.g. a different subagent working concurrently).

## Human Collaboration (Human-in-the-Loop)

**Key insight**: a session's browser window is real and visible — the user can see and interact with it in real time. This unlocks tasks agents cannot do alone.

### When to hand off to the user

Pause and ask the user to act when you hit:
- **Login walls** — credentials, SSO, OAuth flows
- **CAPTCHAs / reCAPTCHA**
- **2FA / MFA** — OTP codes, authenticator apps, SMS
- **Email / phone verification links**
- **Payment forms**
- **Biometric prompts**
- **Any sensitive credential input** — never type passwords on behalf of the user

### How to hand off correctly

1. **Take a screenshot first** so the user can see the current state.
2. **Tell the user exactly what to do**, e.g. "The browser is showing a login page. Please enter your credentials and click Sign In, then tell me when you're done."
3. **Wait** — do not poll or retry. Just pause and wait for the user's reply.
4. **Take a new screenshot** after the user signals completion to confirm the state.
5. **Resume automation** from the new state.

Never skip a human handoff to guess or fake credentials.
