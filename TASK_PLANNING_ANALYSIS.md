# Task Planning, Todos & Subagent System Analysis

This document analyzes how task planning, todos, agent modes, and subagents work in OpenCode.

## Table of Contents

1. [Todo System](#todo-system)
2. [Plan Mode](#plan-mode)
3. [Explore Subagent (Research Mode)](#explore-subagent-research-mode)
4. [Comparison](#comparison)
5. [Subagent Architecture](#subagent-architecture)

---

## Todo System

The todo system tracks steps during active execution. It is **not automated** - the AI manually works through tasks based on prompt instructions.

### When Todos Are Created

The AI is instructed via prompts (`packages/opencode/src/tool/todowrite.txt`) to create todos when:

| Condition | Example |
|-----------|---------|
| **3+ distinct steps** | "Add auth with login, signup, and password reset" |
| **Complex/non-trivial tasks** | Tasks requiring careful planning |
| **User provides a list** | "Fix the bug, update tests, and refactor" |
| **User explicitly asks** | "Create a todo list for this" |

**When NOT to use todos:**
- Single straightforward task
- Trivial work (< 3 steps)
- Purely conversational requests

### Storage

Todos are stored per-session in the storage system:
- Path: `["todo", sessionID]`
- Structure: `{ id, content, status, priority }`
- Statuses: `pending`, `in_progress`, `completed`, `cancelled`

Implementation: `packages/opencode/src/session/todo.ts`

### Execution Model

**There is NO automation** - the AI manually:

1. Creates todo list with `TodoWrite`
2. Marks first task `in_progress`
3. Does the work
4. Marks task `completed` immediately
5. Moves to next task

From the prompt (`packages/opencode/src/session/prompt/anthropic.txt`):
> "It is critical that you mark todos as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as completed."

### Key Constraints

- Only **one task can be `in_progress`** at a time
- Subagents **cannot use todos** - explicitly denied in `packages/opencode/src/tool/task.ts:73-80`

### UI Display

Todos appear in the CLI sidebar (`packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx:205-223`) with status icons:
- `[✓]` completed
- `[•]` in progress
- `[ ]` pending

---

## Plan Mode

Plan mode is an **experimental feature** for research and planning BEFORE execution.

### Activation

Requires experimental flag: `OPENCODE_EXPERIMENTAL_PLAN_MODE=true`

Can be triggered by:
- AI calling `plan_enter` tool (when it detects complex task)
- User pressing `Tab` to cycle to plan agent
- Manual agent switching

### Storage

Plans stored as markdown files:

```
# With Git repo:
<project>/.opencode/plans/<timestamp>-<session-slug>.md

# Without Git:
~/.local/share/opencode/plans/<timestamp>-<session-slug>.md
```

Implementation: `packages/opencode/src/session/index.ts:235-240`

### Special Tools

| Tool | Purpose |
|------|---------|
| `plan_enter` | Switches to plan mode |
| `plan_exit` | Switches to build mode after plan complete |

Implementation: `packages/opencode/src/tool/plan.ts`

### 5-Phase Workflow

When in plan mode, the AI follows (`packages/opencode/src/session/prompt.ts:1243-1327`):

1. **Initial Understanding** - Launch up to 3 Explore agents in parallel
2. **Design** - Launch general agents for implementation approach
3. **Review** - Read critical files, ask user questions
4. **Final Plan** - Write structured plan to the plan file
5. **Exit** - Call `plan_exit` tool

### Permission Restrictions

The plan agent has explicit restrictions (`packages/opencode/src/agent/agent.ts:87-108`):
- `edit`: **denied** (except `.opencode/plans/*.md`)
- `bash`: **denied**
- `plan_exit`: allowed
- `question`: allowed

This enforces read-only research mode.

### End-to-End Workflow

```
User Request
    → AI detects complex task
    → Calls plan_enter tool
    → User confirms
    → Plan mode activated (read-only)
    → AI follows 5-phase workflow
    → Writes plan to .opencode/plans/*.md
    → Calls plan_exit tool
    → User confirms
    → Build mode activated
    → AI reads plan file and implements
```

---

## Explore Subagent (Research Mode)

The **explore subagent** is a specialized research mode for fast, parallel codebase exploration. It's strictly read-only and optimized for searching.

### When It's Used

The main system prompt (`packages/opencode/src/session/prompt/anthropic.txt:86`) instructs:
> "When exploring the codebase to gather context or to answer a question that is not a needle query for a specific file/class/function, it is CRITICAL that you use the Task tool instead of running search commands directly."

Examples:
- "Where are errors from the client handled?" → Use explore agent
- "What is the codebase structure?" → Use explore agent

### Invocation

Called via the `Task` tool with `subagent_type: "Explore"`:

```typescript
Task({
  description: "Find auth handlers",
  prompt: "Search for authentication handling code...",
  subagent_type: "Explore"
})
```

### Thoroughness Levels

The caller can specify thoroughness:

| Level | Use Case |
|-------|----------|
| **quick** | Basic searches, known file locations |
| **medium** | Moderate exploration |
| **very thorough** | Comprehensive analysis across multiple locations and naming conventions |

### Permissions (Strictly Read-Only)

Defined in `packages/opencode/src/agent/agent.ts:124-150`:

**Allowed:**
- `grep`, `glob`, `list`, `read`
- `bash` (read-only operations like `ls`)
- `webfetch`, `websearch`, `codesearch`

**Denied:**
- `edit`, `write`, `todoread`, `todowrite`, and everything else

### Parallel Execution

The system supports launching **up to 3 explore agents in parallel** for efficient context gathering.

From plan mode workflow (`packages/opencode/src/session/prompt.ts:1267-1271`):
- Use 1 agent when task is isolated to known files
- Use multiple agents when scope is uncertain or multiple areas involved
- Maximum 3 agents, but use minimum necessary

### System Prompt

Location: `packages/opencode/src/agent/prompt/explore.txt`

```
You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use Glob for broad file pattern matching
- Use Grep for searching file contents with regex
- Use Read when you know the specific file path you need to read
- Use Bash for file operations like copying, moving, or listing directory contents
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- Do not create any files, or run bash commands that modify the user's system state
```

---

## Comparison

| Feature | Todo System | Plan Mode | Explore Subagent |
|---------|-------------|-----------|------------------|
| **Purpose** | Track steps during execution | Research and planning WITHOUT execution | Fast codebase search |
| **Type** | Tool | Primary Agent | Subagent |
| **File Editing** | Allowed | Denied (except plan file) | Denied |
| **Bash Commands** | Allowed | Denied | Read-only only |
| **When Used** | During active work | Before implementation starts | Context gathering |
| **Agent** | `build` agent | `plan` agent | `explore` subagent |
| **Tools** | `TodoWrite`, `TodoRead` | `plan_enter`, `plan_exit` | `grep`, `glob`, `read` |
| **Storage** | Session state (database) | Markdown files in `.opencode/plans/` | None (returns results) |
| **Parallelism** | Sequential (1 at a time) | Single agent | Up to 3 in parallel |
| **Experimental** | No | Yes (requires flag) | No |

---

## Key Files Reference

### Todo System
- `packages/opencode/src/tool/todo.ts` - Tool implementation
- `packages/opencode/src/tool/todowrite.txt` - When to use todos
- `packages/opencode/src/session/todo.ts` - State management
- `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx` - UI display

### Plan Mode
- `packages/opencode/src/tool/plan.ts` - PlanEnterTool & PlanExitTool
- `packages/opencode/src/tool/plan-enter.txt` - When to use plan_enter
- `packages/opencode/src/tool/plan-exit.txt` - When to use plan_exit
- `packages/opencode/src/session/prompt.ts:1191-1329` - Plan mode prompt injection
- `packages/opencode/src/session/index.ts:235-240` - Plan file path resolution
- `packages/opencode/src/agent/agent.ts:87-108` - Plan agent permissions

### Configuration
- `packages/opencode/src/flag/flag.ts:48` - OPENCODE_EXPERIMENTAL_PLAN_MODE flag
- `packages/opencode/src/tool/registry.ts:115` - Tool registration

### Explore Subagent
- `packages/opencode/src/agent/agent.ts:124-150` - Explore agent definition
- `packages/opencode/src/agent/prompt/explore.txt` - Explore system prompt
- `packages/opencode/src/tool/task.ts` - Task tool (invokes subagents)
- `packages/opencode/src/tool/task.txt` - Task tool description

---

## Subagent Architecture

This section provides a deep dive into how subagents are implemented.

### What Makes a Subagent Different from a Primary Agent

Agents are defined in `packages/opencode/src/agent/agent.ts` with a `mode` field:

```typescript
Agent.Info = {
  name: string,
  mode: "subagent" | "primary" | "all",  // Key differentiator
  permission: PermissionNext.Ruleset,
  prompt?: string,
  // ...other fields
}
```

| Aspect | Primary Agent | Subagent |
|--------|--------------|----------|
| Selection | Can be default agent, selectable via Tab | Only via Task tool |
| UI visibility | Listed in agent picker | Hidden from primary listings |
| Direct invocation | User can switch to it | Parent agent spawns it |
| Session | Main conversation session | Child session with `parentID` |

### Task Tool: The Gateway to Subagents

**Location**: `packages/opencode/src/tool/task.ts`

```typescript
TaskTool.execute({
  description: string,      // Short 3-5 word description
  prompt: string,           // Detailed task instructions
  subagent_type: string,    // Name of subagent (e.g., "explore", "general")
  session_id?: string,      // Optional: continue existing session
})
```

**Execution Flow**:

1. **Permission Check** - Verify parent can use this subagent type
2. **Session Creation** - Create child session with `parentID: ctx.sessionID`
3. **Apply Restrictions** - Deny todowrite, todoread, task (unless explicit permission)
4. **Execute** - Call `SessionPrompt.prompt()` with child session
5. **Track Progress** - Subscribe to `MessageV2.Event.PartUpdated` events
6. **Return Result** - Text output + session_id for continuation

### Context Sharing Model

**Subagents are isolated** - they do NOT automatically inherit parent context:

| Shared | Not Shared |
|--------|------------|
| File system (same worktree) | Parent's conversation history |
| Project configuration | Parent's message context |
| Explicit prompt content | Implicit state |

The parent must explicitly include any needed context in the prompt. This is by design for:
- Clear isolation boundaries
- Predictable behavior
- Fine-grained control over information flow

### Permission System

**Location**: `packages/opencode/src/permission/next.ts`

Permissions are rule-based with pattern matching:

```typescript
PermissionNext.Ruleset = Array<{
  permission: string,   // Tool name: "read", "edit", "bash", "task"
  pattern: string,      // Glob pattern: "*.ts", "/tmp/*", "*"
  action: "allow" | "deny" | "ask"
}>
```

**Evaluation**: Rules evaluated in order, last matching rule wins.

**Subagent Base Restrictions** (applied to all subagents):
```typescript
permission: [
  { permission: "todowrite", pattern: "*", action: "deny" },
  { permission: "todoread", pattern: "*", action: "deny" },
  { permission: "task", pattern: "*", action: "deny" },  // Unless explicit
]
```

**Example: Explore Agent Permissions**:
```typescript
permission: {
  "*": "deny",           // Deny everything by default
  "grep": "allow",
  "glob": "allow",
  "list": "allow",
  "bash": "allow",       // Read-only operations only
  "read": "allow",
  "webfetch": "allow",
  "websearch": "allow",
}
```

### Session Lifecycle

**Creation**:
```typescript
Session.create({
  parentID: parentSessionID,           // Links to parent
  title: `${description} (@${agent} subagent)`,
  permission: restrictedPermissions,
})
```

**Execution Loop** (`packages/opencode/src/session/prompt.ts:258-637`):
1. Process messages
2. Handle tool calls
3. Manage retries and errors
4. Check finish conditions (stop sequence, max steps, error)

**Termination**:
- Agent reaches stop sequence
- Max steps reached (configurable per agent via `steps` field)
- Error occurs
- Parent cancels via abort signal

**Cleanup**:
- Sessions persist in storage for history
- Can be reused via `session_id` parameter
- Deleted recursively when parent session deleted

### Available Native Subagents

| Name | Purpose | Key Permissions |
|------|---------|-----------------|
| **`general`** | Multi-step tasks, complex work | Most tools allowed, no todos |
| **`explore`** | Fast codebase search | Read-only: grep, glob, read, bash |

**Hidden System Agents** (not subagents, but related):
- `compaction` - Summarize conversation when context limit reached
- `title` - Generate session titles
- `summary` - Summarize conversations

### Parallel Execution

Subagents support parallel execution through multiple concurrent tool calls:

```
Parent sends single message with 3 Task tool calls
    → Task Tool #1 spawns explore subagent A
    → Task Tool #2 spawns explore subagent B  (concurrent)
    → Task Tool #3 spawns explore subagent C  (concurrent)
    ← All results collected
Parent receives all 3 results
```

From the prompts:
> "Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses"

**Guidelines for parallel agents** (from plan mode):
- Use 1 agent when task is isolated to known files
- Use multiple when scope uncertain or multiple areas involved
- Maximum 3 agents recommended
- Give each agent a specific search focus

### Session Continuation

Subagent sessions can be continued across invocations:

```typescript
// First call - creates new session
TaskTool.execute({ prompt: "Find auth code", subagent_type: "explore" })
// Returns: session_id: "abc123"

// Later call - continues same session
TaskTool.execute({
  prompt: "Now find the tests for that auth code",
  subagent_type: "explore",
  session_id: "abc123"  // Continue previous context
})
```

This allows multi-turn conversations with subagents while maintaining their isolation from the parent.

### Communication Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Parent Agent                              │
│  (build agent, plan agent, or custom primary)                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Task Tool Call
                              │ {prompt, subagent_type}
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Task Tool                                 │
│  1. Check permissions                                           │
│  2. Create child session (parentID link)                        │
│  3. Apply restrictions (no todos, no nested tasks)              │
│  4. Execute SessionPrompt.prompt()                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Subagent Session                             │
│  - Isolated conversation context                                │
│  - Own message history                                          │
│  - Restricted tool access per agent type                        │
│  - Executes autonomously until completion                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Result + session_id
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Parent Agent                              │
│  Receives: text response + tool call summary + session_id       │
│  Can continue subagent session or start new one                 │
└─────────────────────────────────────────────────────────────────┘
```

### Key Implementation Files

| File | Purpose |
|------|---------|
| `packages/opencode/src/agent/agent.ts` | Agent definitions (native + custom) |
| `packages/opencode/src/tool/task.ts` | Task tool implementation |
| `packages/opencode/src/tool/task.txt` | Task tool description/prompt |
| `packages/opencode/src/session/index.ts` | Session creation and management |
| `packages/opencode/src/session/prompt.ts` | Execution loop and prompt handling |
| `packages/opencode/src/permission/next.ts` | Permission system |
| `packages/opencode/src/session/message-v2.ts` | Message types and events |
| `packages/opencode/src/agent/prompt/explore.txt` | Explore agent system prompt |
