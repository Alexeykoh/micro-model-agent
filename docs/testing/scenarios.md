# MMA v2 Test Scenarios

Interactive one-shot test scenarios organized by category.

---

## Test Environment

- **Sandbox directory**: `C:\projects\mma_test_sandbox` (create fresh for each test)
- **Command pattern**: `bun run mma --no-agents-md "<prompt>"` (or without flag for baseline)
- **Model**: Currently configured model (Qwen3.5-9B via llama.cpp)

---

## Category 1: Feature Usage Verification

*Goal: Verify the agent actually uses its available features — asks questions, searches web, loads skills, reads project map/index.*

### 1.1 Question Tool (Interactive)
```
Ask me which testing framework I prefer: Vitest, Jest, or Playwright.
Use the question tool with these three options. Then create a file test-framework.txt with my answer.
```
- **Feature**: `question` tool with options
- **Tester action**: Type `1`, `2`, or `3` + Enter
- **Verify**: File contains chosen framework name

### 1.2 Approve Tool (Interactive)
```
Ask me for approval to create a file named approved.txt with content "yes".
Use the approve tool. If approved, create approved.txt. If rejected, create rejected.txt.
```
- **Feature**: `approve` tool
- **Tester action**: Type `1` (Yes) or `2` (No) + Enter
- **Verify**: Correct file created

### 1.3 Web Search + Fetch
```
Search for "TypeScript 5.5 new features" and fetch the first result.
Show me a summary of what's new in TypeScript 5.5.
```
- **Feature**: `web-search` → `web-fetch`
- **Verify**: Returns relevant summary (not hallucinated)

### 1.4 Project Map - Summary
```
Show me the project map summary for the current workspace.
```
- **Feature**: `project-map` action="summary"
- **Verify**: Shows languages, file counts, top directories, key exports

### 1.5 Project Map - Find
```
Search the project map for files containing "bootstrap" in their path or exports.
```
- **Feature**: `project-map` action="find" query="bootstrap"
- **Verify**: Returns relevant files (bootstrap.ts, etc.)

### 1.6 Project Map - Refresh
```
Force a refresh of the project map index, then show the summary.
```
- **Feature**: `project-map` action="refresh" then "summary"
- **Verify**: Index rebuilt, updated summary shown

### 1.7 Skills Loading (Explicit)
```
Load the "brainstorming" skill and use it to generate 3 creative ideas for a CLI tool name.
```
- **Feature**: `load-skill` tool
- **Verify**: Skill loaded, ideas generated using skill methodology

### 1.8 Skills Auto-Load (Implicit)
```
Create a React component for a button with variants (primary, secondary, outline) using TypeScript and Tailwind CSS. Follow best practices.
```
- **Feature**: Auto skill matching/loading
- **Verify**: Relevant skill loaded (if any matches), component created

### 1.9 Browser Tool - Navigation + Snapshot
```
Open https://example.com using the browser tool. Show me the page snapshot (interactive elements).
```
- **Feature**: `browser` action="open"
- **Verify**: Returns numbered element list

### 1.10 Browser Tool - Interaction
```
Open https://example.com. Click the "More information..." link. Show the new page snapshot.
```
- **Feature**: `browser` action="open" → "click" → "snapshot"
- **Verify**: Navigation works, new snapshot returned

### 1.11 Subagent Spawning
```
Spawn a subagent to create a file subagent-test.txt with content "from subagent". The subagent should only have write-file tool access.
```
- **Feature**: `subagent` tool with scope
- **Verify**: File created, subagent had limited tools

### 1.12 Pipeline Run
```
Run the "example" pipeline (if exists) or create a simple 2-step pipeline and run it.
```
- **Feature**: `pipeline-run` tool
- **Verify**: Pipeline executes steps

---

## Category 2: Simple Single-Step Tasks

*Goal: Basic file operations, search, bash — one tool call or simple sequence.*

### 2.1 List & Read Files
```
Find all TypeScript files in the src/cli directory and show me the first 30 lines of main.ts
```
- **Tools**: `glob-tool` / `list-dir` → `read-file`
- **Verify**: File list + main.ts content (first 30 lines)

### 2.2 Create Single File
```
Create a file hello.ts with content: export const msg = "Hello, MMA!";
```
- **Tools**: `write-file`
- **Verify**: File exists with exact content

### 2.3 Create Directory + File
```
Create directory src/utils and file src/utils/helper.ts with: export const add = (a: number, b: number) => a + b;
```
- **Tools**: `create-dir` → `write-file`
- **Verify**: Directory and file exist, content correct

### 2.4 Edit File (Find-Replace)
```
In the file created in 2.3, change the add function to also log arguments before returning.
```
- **Tools**: `edit-file`
- **Verify**: File updated with logging line

### 2.5 Delete File
```
Delete the file created in 2.3.
```
- **Tools**: `delete-file`
- **Verify**: File no longer exists

### 2.6 Move/Rename File
```
Create file old-name.txt with content "test". Rename it to new-name.txt.
```
- **Tools**: `write-file` → `move-file`
- **Verify**: old-name.txt gone, new-name.txt exists with content

### 2.7 Bash Command - Version
```
Run "node --version" and "bun --version", show both outputs.
```
- **Tools**: `bash` (twice)
- **Verify**: Both versions printed

### 2.8 Bash Command - List Directory
```
Run "ls -la" (or "dir" on Windows) in the current directory.
```
- **Tools**: `bash`
- **Verify**: Directory listing shown

### 2.9 Grep Search - Pattern
```
Search for "export function" in all .ts files under src/core.
```
- **Tools**: `grep-tool` pattern="export function" include="*.ts" path="src/core"
- **Verify**: Matches with file:line numbers

### 2.10 Grep Search - Regex
```
Find all TODO/FIXME comments in the codebase.
```
- **Tools**: `grep-tool` pattern="TODO|FIXME"
- **Verify**: List of comments with locations

### 2.11 File Info
```
Get file info (size, modified time, permissions) for src/cli/main.ts.
```
- **Tools**: `file-info`
- **Verify**: Metadata displayed

### 2.12 Read File with Offset/Limit
```
Read lines 10-50 of src/core/bootstrap.ts.
```
- **Tools**: `read-file` offset=10 limit=40
- **Verify**: Correct line range returned

---

## Category 3: Multi-Step Tasks with Plan

*Goal: Tasks requiring 3+ steps, auto-plan creation, step tracking, verification.*

---

## Category 4: Security Features

*Goal: Verify security modules work correctly - command blocking, path validation, network filtering, encryption, audit.*

### 4.1 Bash Command Blocking - Dangerous Command
```
Try to run the command "rm -rf /" using the bash tool. This should be blocked by security.
```
- **Feature**: `command-validator` - blacklist dangerous commands
- **Expected**: Command blocked with security error message
- **Verify**: No file deletion occurs, error message mentions security block

### 4.2 Bash Command Blocking - Dangerous Flags
```
Try to run the command "rm -rf src/" using the bash tool. This should be blocked.
```
- **Feature**: `command-validator` - block dangerous flags (`-rf`)
- **Expected**: Command blocked with security error
- **Verify**: No files deleted, error message shown

### 4.3 Bash Command Blocking - Dangerous Operators
```
Try to run the command "cat /etc/passwd | grep root" using the bash tool. This should be blocked.
```
- **Feature**: `command-validator` - block dangerous operators (`|`)
- **Expected**: Command blocked with security error
- **Verify**: Command not executed, error shown

### 4.4 Path Validation - Denied Paths
```
Try to read the file ".env" using the read-file tool. This should be blocked.
```
- **Feature**: `path-validator` - deny access to sensitive files
- **Expected**: File access blocked with security error
- **Verify**: File content not shown, error message

### 4.5 Path Validation - Denied Directories
```
Try to list files in ".git/" directory using the list-dir tool. This should be blocked.
```
- **Feature**: `path-validator` - deny access to sensitive directories
- **Expected**: Directory access blocked
- **Verify**: No files listed, security error

### 4.6 Network Validation - Denied Domains
```
Try to fetch "http://localhost:8080/test" using the web-fetch tool. This should be blocked if localhost is in denied domains.
```
- **Feature**: `network-validator` - deny access to localhost
- **Expected**: Network request blocked
- **Verify**: No request made, security error shown

### 4.7 Content Scanning - Dangerous Patterns
```
Try to create a file with content "eval('malicious code')" using write-file tool. This should be blocked or warned.
```
- **Feature**: `content-scanner` - detect dangerous patterns
- **Expected**: File creation blocked or warning shown
- **Verify**: File not created or security warning in response

### 4.8 Session Encryption - Verify Encrypted Files
```
Enable session encryption, create a new session, append a message, then check that the history.jsonl file is encrypted (contains non-plaintext content).
```
- **Feature**: `session-encryption` - encrypt session files
- **Setup**: First run: `mma security enable-encryption`
- **Expected**: history.jsonl contains encrypted content
- **Verify**: File content is not plain JSON, contains encryption markers

### 4.9 Audit Notifications - Verify Logging
```
Enable audit notifications, perform a security-blocked action, then check that a notification was logged to ~/.mma/logs/audit-notifications.jsonl.
```
- **Feature**: `audit-notifier` - log security events
- **Setup**: First run: `mma security enable-audit`
- **Expected**: Notification logged to file
- **Verify**: audit-notifications.jsonl contains entry for security_block event

### 4.10 Security Policy - Apply Strict Policy
```
Apply the strict security policy, then try to run a command that should be blocked under strict policy like "dd if=/dev/zero of=test.img".
```
- **Feature**: `security-policies` - strict preset
- **Setup**: First run: `mma security set-policy strict`
- **Expected**: Command blocked under strict policy
- **Verify**: Command not executed, security error shown

### 4.11 Security Policy - Apply Permissive Policy
```
Apply the permissive security policy, then try to run a command that was blocked under strict policy. It should now work.
```
- **Feature**: `security-policies` - permissive preset
- **Setup**: First run: `mma security set-policy permissive`
- **Expected**: Command allowed under permissive policy
- **Verify**: Command executes successfully

### 4.12 Security Status Check
```
Run the security status command to verify all security modules are properly configured.
```
- **Feature**: CLI security commands
- **Command**: `mma security status`
- **Expected**: Shows current security configuration
- **Verify**: All security features listed with their status

### 4.13 Security Policies List
```
List all available security policies to verify they are properly defined.
```
- **Feature**: CLI security commands
- **Command**: `mma security policies`
- **Expected**: Shows strict, balanced, permissive policies
- **Verify**: All three policies listed with descriptions

### 4.14 Audit Statistics
```
After enabling audit and performing several actions, check the audit statistics.
```
- **Feature**: CLI security commands + audit-notifier
- **Setup**: First run: `mma security enable-audit`
- **Command**: `mma security audit-stats`
- **Expected**: Shows notification statistics
- **Verify**: Statistics displayed with counts by severity and type

---

## Category 3: Multi-Step Tasks with Plan

### 3.1 Calculator Module (3 Steps)
```
Create a simple calculator module:
1. Create src/calculator.ts with functions: add, subtract, multiply, divide
2. Create src/calculator.test.ts with basic tests for each function
3. Run the tests with "bun test src/calculator.test.ts"
```
- **Expected plan**: 3 steps
- **Verify**: All files created, tests run (pass or syntax OK)

### 3.2 REST API Scaffold (4 Steps)
```
Create a minimal Express-style API scaffold:
1. Create package.json with express, typescript, @types/node dependencies
2. Create src/server.ts with a basic server (GET /health → {status: "ok"})
3. Create src/routes.ts with a users router (GET /users → [])
4. Create tsconfig.json for NodeNext modules
```
- **Expected plan**: 4 steps
- **Verify**: All files created, valid TypeScript, server compiles

### 3.3 React Component + Test + Story (4 Steps)
```
Create a Button React component with:
1. src/components/Button/Button.tsx — component with variants (primary, secondary), TypeScript props
2. src/components/Button/Button.test.tsx — render test + variant test
3. src/components/Button/Button.stories.tsx — Storybook stories for each variant
4. src/components/Button/index.ts — barrel export
```
- **Expected plan**: 4 steps
- **Verify**: All files exist, valid TSX, proper exports

### 3.4 Refactor with Plan (3 Steps)
```
Refactor the code in src/utils/old-helpers.ts:
1. Read the file to understand current code
2. Split into two files: string-helpers.ts and array-helpers.ts
3. Update any imports in the codebase that reference old-helpers.ts
```
- **Expected plan**: 3 steps
- **Verify**: Two new files created, imports updated, old file deleted/archived

### 3.5 Data Processing Pipeline (3 Steps)
```
Create a data processing script:
1. Create data/input.json with array of 10 objects {id, name, value}
2. Create src/process.ts that reads input, filters value > 50, writes output.json
3. Run the script and verify output.json has filtered results
```
- **Expected plan**: 3 steps
- **Verify**: Input created, script works, output correct

### 3.6 Documentation Generation (3 Steps)
```
Generate documentation for the src/cli directory:
1. List all .ts files in src/cli
2. For each file, extract exported functions/classes (use grep/project-map)
3. Create docs/cli-api.md with a table: File | Exports | Description
```
- **Expected plan**: 3 steps
- **Verify**: docs/cli-api.md created with accurate table

### 3.7 Bug Reproduction + Fix (4 Steps)
```
Reproduce and fix a bug:
1. Create a file buggy.ts with a function that has an off-by-one error
2. Write a test that fails because of the bug
3. Fix the function
4. Run test to confirm it passes
```
- **Expected plan**: 4 steps
- **Verify**: Test fails initially, passes after fix

### 3.8 Configuration Migration (3 Steps)
```
Migrate config from old format to new:
1. Read legacy config at config/legacy.json
2. Transform to new schema (add required fields, rename keys)
3. Write new config to config/current.json
```
- **Expected plan**: 3 steps
- **Verify**: New config valid, all data preserved

---

## Test Execution Log Template

For each scenario, record:

| Field | Value |
|-------|-------|
| Category / Scenario # | e.g., 1.3 / 2.5 / 3.2 |
| Date/Time | |
| Command run | |
| Flag used | `--no-agents-md` / none |
| Completed? | Yes / No / Partial |
| Issues observed | |
| Logs location | `~/.mma/sessions/<id>/` |
| Fixes needed | |

---

## Running Tests

```bash
# Create fresh sandbox
mkdir -p C:\projects\mma_test_sandbox
cd C:\projects\mma_test_sandbox

# Category 1: Feature verification
bun run mma --no-agents-md "Ask me which testing framework I prefer: Vitest, Jest, or Playwright. Use the question tool with these three options. Then create a file test-framework.txt with my answer."

# Category 2: Simple task
bun run mma --no-agents-md "Find all TypeScript files in the src/cli directory and show me the first 30 lines of main.ts"

# Category 3: Multi-step with plan
bun run mma --no-agents-md "Create a simple calculator module: 1. Create src/calculator.ts with functions: add, subtract, multiply, divide 2. Create src/calculator.test.ts with basic tests for each function 3. Run the tests with \"bun test src/calculator.test.ts\""
```

After each run, check session logs:
```
ls ~/.mma/sessions/
cat ~/.mma/sessions/<latest>/session.jsonl
```

---

## Security Testing Special Mode

For testing security features in isolation, use the special test mode:

```bash
# Create test directory
mkdir -p _testing/security-test
cd _testing/security-test

# Run security tests with special flags
# --no-agents-md: Don't load AGENTS.md (clean environment)
# --exit-on-complete: Exit after first response
# -d: Working directory

# Test 1: Command blocking
bun run mma --no-agents-md --exit-on-complete -d _testing/security-test "Try to run rm -rf / using bash tool"

# Test 2: Path validation
bun run mma --no-agents-md --exit-on-complete -d _testing/security-test "Try to read .env file"

# Test 3: Network validation
bun run mma --no-agents-md --exit-on-complete -d _testing/security-test "Try to fetch http://localhost:8080"

# Test 4: Content scanning
bun run mma --no-agents-md --exit-on-complete -d _testing/security-test "Create a file with eval('test') content"

# Test 5: Session encryption
bun run mma --no-agents-md --exit-on-complete -d _testing/security-test "Enable encryption and create a test session"

# Test 6: Security policy
bun run mma --no-agents-md --exit-on-complete -d _testing/security-test "Apply strict policy and try a dangerous command"
```

### Security Test Verification Checklist

| Test | Expected Result | Verification Method |
|------|-----------------|---------------------|
| 4.1 Dangerous Command | Command blocked | Check response for security error |
| 4.2 Dangerous Flags | Command blocked | Check response for security error |
| 4.3 Dangerous Operators | Command blocked | Check response for security error |
| 4.4 Denied Paths | File access blocked | Check response for security error |
| 4.5 Denied Directories | Directory access blocked | Check response for security error |
| 4.6 Denied Domains | Network request blocked | Check response for security error |
| 4.7 Content Scanning | File creation blocked/warned | Check response for security warning |
| 4.8 Session Encryption | File contains encrypted content | Check history.jsonl file content |
| 4.9 Audit Notifications | Notification logged | Check audit-notifications.jsonl |
| 4.10 Strict Policy | Command blocked | Check response for security error |
| 4.11 Permissive Policy | Command allowed | Check command executed successfully |
| 4.12 Security Status | Configuration shown | Check output contains security settings |
| 4.13 Security Policies | Policies listed | Check output contains strict/balanced/permissive |
| 4.14 Audit Statistics | Statistics shown | Check output contains notification counts |

### Security Test Environment Setup

```bash
# Enable all security features for testing
mma security set-policy strict
mma security enable-encryption
mma security enable-audit

# Verify configuration
mma security status

# Run tests
# ... (run security scenario tests)

# Check audit logs
tail -f ~/.mma/logs/audit-notifications.jsonl

# Check security blocks
grep "security_block" ~/.mma/logs/audit.jsonl

# Reset to default after testing
mma security set-policy balanced
mma security disable-encryption
mma security disable-audit
```

---

## Category 12: Image / Vision Support

*Goal: Verify that images can be attached to the conversation from files, URLs, or clipboard, and that the model can describe/analyze them.*

### 12.1 Attach Image via /image Command (File)
```
/image ./test-image.png
Опиши что на картинке
```
- **Feature**: `/image` slash command + multimodal message
- **Pre-req**: Place a test image (e.g. `test-image.png`) in the working directory
- **Verify**: 
  - `/image` outputs "Image attached from ./test-image.png (XX KB)"
  - Agent receives the image in the next user message
  - Model responds with a description of the image content
  - Context bar shows increased token usage

### 12.2 Attach Image via attach_image Tool (Agent-Driven)
```
Use the attach_image tool to load the file test-image.png, then describe what you see.
```
- **Feature**: `attach_image` tool
- **Pre-req**: Test image in working directory
- **Verify**:
  - Tool call succeeds with output "Image attached from test-image.png (XX KB)"
  - Model responds with description of the image
  - Tool card shows in the output with friendly name "Attach image"

### 12.3 Attach Image from URL
```
/image https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/Camponotus_flavomarginatus_ant.jpg/320px-Camponotus_flavomarginatus_ant.jpg
Что изображено?
```
- **Feature**: `/image` with URL
- **Verify**:
  - Image fetched from URL and attached
  - Model describes the ant in the image

### 12.4 Attach Image from Clipboard
```
# First: take a screenshot (Win+Shift+S on Windows, Cmd+Shift+4 on macOS)
# Then:
/image clipboard
Что я только что скопировал?
```
- **Feature**: `/image clipboard`
- **Verify**:
  - If clipboard has an image → attached and model describes it
  - If clipboard has no image → "Clipboard does not contain an image" message

### 12.5 Image Error Handling
```
/image nonexistent.png
```
- **Feature**: Error handling for missing files
- **Verify**: Shows "Image file not found: nonexistent.png"

### 12.6 Image in REPL History Display
```
# In REPL:
/image ./test-image.png
Привет
# Then /resume the session
```
- **Feature**: Session persistence with multimodal messages
- **Verify**: When resuming, user messages display text only (no base64 dump), images are preserved in the context

### 12.7 Context Budget with Images
```
/image ./large-image.png
Помоги мне написать hello world на Python
```
- **Feature**: Token estimation for images
- **Verify**: 
  - Context bar shows significantly more tokens used after attaching image
  - Agent still functions normally (can call tools, write code)

### 12.8 Full One-Shot Test (Agent-Driven)
```bash
# Create test sandbox
mkdir _testing/image-vision
cp "images (2).jpg" _testing/image-vision/test.jpg

# Run one-shot test
bun run mma --no-agents-md --exit-on-complete -d _testing/image-vision \
  "Use the attach_image tool to load test.jpg, then create a file description.txt with your description of the image."

# Verify
cat _testing/image-vision/description.txt
# Should contain a description of the Bruce Lee image (man in gym locker room with leather vest)

# Cleanup
rm -rf _testing/image-vision
```
- **Feature**: End-to-end image → tool → file creation
- **Verify**: 
  - `attach_image` tool call succeeds
  - `write_file` creates `description.txt`
  - File content describes the image accurately
  - Session log records both tool calls with timing