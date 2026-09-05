# Model Context Protocol (MCP) Setup Guide

Welcome to your **LINE Summary Bot MCP Server**! This server transforms your bot into a personal executive assistant accessible via Claude Desktop and Claude Mobile.

---

## 🔐 Security & Access Token

Your MCP server is protected with Bearer Access Token authentication:

- **Token Key**: `MCP_ACCESS_TOKEN`
- **Configured Token**: `line_mcp_sec_8e29ec43b3954797b527c194973221f8`

Keep this token secure. All HTTP/SSE requests to `/mcp/sse` must include the header:
```http
Authorization: Bearer line_mcp_sec_8e29ec43b3954797b527c194973221f8
```

---

## 💻 1. Connecting Claude Desktop (Mac)

### Remote SSE Connection (Recommended for Desktop + Mobile Sync)
Add the following snippet to your `claude_desktop_config.json` (located at `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "line-bot": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-sse",
        "https://YOUR-APP-NAME.onrender.com/mcp/sse",
        "--headers",
        "Authorization: Bearer line_mcp_sec_8e29ec43b3954797b527c194973221f8"
      ]
    }
  }
}
```

### Local Stdio Connection (For Local Testing)
```json
{
  "mcpServers": {
    "line-bot-local": {
      "command": "node",
      "args": [
        "/Users/klatangsuwan/Desktop/line-summary-bot/mcp-server.js"
      ]
    }
  }
}
```

---

## 📱 2. Connecting Claude Mobile / Web

To connect from Claude Mobile or Claude Web on your account:
1. Ensure your bot is deployed on Render/Cloud with `MCP_ACCESS_TOKEN` set.
2. In Claude (Mobile/Web), add a Custom MCP SSE connector:
   - **SSE Endpoint URL**: `https://YOUR-APP-NAME.onrender.com/mcp/sse`
   - **Header**: `Authorization: Bearer line_mcp_sec_8e29ec43b3954797b527c194973221f8`

---

## 🛠️ Available MCP Tools in Claude

Once connected, Claude will automatically gain access to 10 powerful tools:

| Tool | Category | Description |
| :--- | :--- | :--- |
| `list_chats` | Chat | List active group chats & 1-on-1 conversations with metadata. |
| `get_chat_history` | Chat | Fetch raw messages for a chat room or across all chats within N hours. |
| `get_morning_briefing` | Analysis | Generate an executive morning summary of overnight messages and action items. |
| `get_attention_items` | Analysis | Find questions directed to you, urgent requests, and mentions across chats. |
| `search_messages` | Search | Perform full-text search across all stored LINE messages. |
| `send_line_message` | LINE Dispatch | Send a message to a chat room or user (for approved draft responses). |
| `add_memory` | Memory | Save a decision, contact info, deadline, or link into the Firestore knowledge base. |
| `search_memories` | Memory | Query stored project facts, decisions, and long-term memories. |
| `get_bot_rules` | Rules | Read current auto-response rules and confidence mode. |
| `set_bot_rule` | Rules | Update response permissions (toggle between `drafting` and `autonomous` mode). |

---

## 🌅 3. Automated Morning Push Configuration

To receive an automated Executive Morning Briefing in your personal LINE chat every morning at 8:00 AM:

1. Obtain your personal LINE User ID (or target Group ID).
2. Set the environment variable in `.env` or Render Dashboard:
   ```env
   MORNING_BRIEF_LINE_ID=U1234567890abcdef...
   ```
3. The bot will automatically compile overnight messages and push the summary to your LINE chat at 8:00 AM daily.

---

## 🤖 4. Auto-Response Progression (Drafting -> Autonomous)

- **Default (Drafting Mode)**: Claude reviews chat history and drafts suggested responses. You can inspect the draft in Claude and instruct Claude to call `send_line_message` to dispatch it.
- **Switching to Autonomous Mode**: Once you are confident in the bot's responses, you can ask Claude:
  > *"Update bot rules to set mode to autonomous for business_hours topics"*

  Claude will execute `set_bot_rule` to enable automatic responses for those categories.
