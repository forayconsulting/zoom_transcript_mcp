# Zoom Transcript MCP Server

An MCP (Model Context Protocol) server for interacting with Zoom Cloud Recording transcripts. This server allows you to list, download, search, and manage your Zoom meeting transcripts through a structured interface.

<a href="https://glama.ai/mcp/servers/b01uqjtp7w">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/b01uqjtp7w/badge" alt="Zoom Transcript Server MCP server" />
</a>

## Features

- **List Meetings**: View all available Zoom meetings with recordings
- **Download Transcripts**: Download transcripts from specific meetings by ID or UUID
- **Get Recent Transcripts**: Automatically download transcripts from recent meetings
- **Search Transcripts**: Search across all downloaded transcripts for specific content
- **Organized Storage**: Transcripts are stored in a structured file system by month

## Prerequisites

- Node.js (v16 or higher)
- Zoom Account with Cloud Recording enabled
- Zoom OAuth App credentials (Account ID, Client ID, Client Secret)

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/yourusername/zoom_transcript_mcp.git
   cd zoom_transcript_mcp
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

## Configuration

Create a `.env` file in the root directory with the following variables:

```
ZOOM_ACCOUNT_ID=your_zoom_account_id
ZOOM_CLIENT_ID=your_zoom_client_id
ZOOM_CLIENT_SECRET=your_zoom_client_secret
TRANSCRIPTS_DIR=/path/to/transcripts/directory  # Optional, defaults to ./transcripts
```

Alternatively, you can configure the server through your MCP settings file:

```json
{
  "mcpServers": {
    "zoom-transcripts": {
      "command": "node",
      "args": ["/path/to/zoom-transcripts-server/build/index.js"],
      "env": {
        "ZOOM_ACCOUNT_ID": "your_zoom_account_id",
        "ZOOM_CLIENT_ID": "your_zoom_client_id",
        "ZOOM_CLIENT_SECRET": "your_zoom_client_secret",
        "TRANSCRIPTS_DIR": "/path/to/transcripts/directory"  // Optional
      }
    }
  }
}
```

### Obtaining Zoom Credentials

1. Go to the [Zoom App Marketplace](https://marketplace.zoom.us/) and sign in
2. Click "Develop" > "Build App"
3. Choose "Server-to-Server OAuth" app type
4. Fill in the required information
5. Under "Scopes", add the following permissions:
   - `cloud_recording:read:list_account_recordings:admin`
   - `cloud_recording:read:recording:admin`
   - `cloud_recording:read:list_user_recordings:admin`
6. Save and activate your app
7. Note your Account ID, Client ID, and Client Secret

## Usage

### Available Tools

#### 1. list_meetings

Lists available Zoom meetings with recordings.

```json
{
  "dateRange": {
    "from": "2025-01-01",
    "to": "2025-03-31"
  },
  "participant": "John Doe"  // Optional
}
```

#### 2. download_transcript

Downloads a transcript for a specific meeting.

```json
{
  "meetingId": "123456789"  // Meeting ID or UUID
}
```

#### 3. get_recent_transcripts

Downloads transcripts from recent meetings.

```json
{
  "count": 5  // Number of recent meetings to fetch (default: 5)
}
```

#### 4. search_transcripts

Searches across downloaded transcripts for specific content.

```json
{
  "query": "AI discussion",
  "dateRange": {  // Optional
    "from": "2025-01-01",
    "to": "2025-03-31"
  }
}
```

### Example Usage with Claude

```
<use_mcp_tool>
<server_name>zoom-transcripts</server_name>
<tool_name>search_transcripts</tool_name>
<arguments>
{
  "query": "project timeline"
}
</arguments>
</use_mcp_tool>
```

## Transcript Storage

Transcripts are stored in the following structure:

```
transcripts/
├── YYYY-MM/
│   ├── YYYY-MM-DD_HH-MM-SS_Meeting-Topic_MeetingID.vtt
│   └── metadata/
│       └── YYYY-MM-DD_HH-MM-SS_Meeting-Topic_MeetingID.json
```

Each transcript has a corresponding metadata JSON file containing:
- Meeting ID and UUID
- Topic
- Start time and duration
- Participants (extracted from the transcript)
- File path to the transcript

## Development

### Project Structure

```
zoom_transcript_mcp/
├── src/
│   └── index.ts
├── package.json
├── tsconfig.json
├── .gitignore
├── README.md
└── .env.example
```

### Building

```bash
npm run build
```

### Running Locally

```bash
node build/index.js
```

## License

MIT