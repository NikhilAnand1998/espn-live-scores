# espn-live-scores

A lightweight Python CLI that polls ESPN's unofficial scoreboard API and logs live game scores every 15 seconds. No API key or external dependencies required.

## Supported Sports

| Key     | Sport                        |
|---------|------------------------------|
| `nhl`   | NHL Hockey                   |
| `ncaab` | NCAA Men's College Basketball |

## Usage

### List today's games

Useful for finding team abbreviations.

```bash
python scores.py nhl
python scores.py ncaab
```

### Track a specific team

Polls every 15 seconds and logs the latest score.

```bash
python scores.py nhl TOR
python scores.py ncaab Duke
```

### Skip final games (`-l` flag)

Only show games that are live or upcoming — filters out completed games.

```bash
python scores.py ncaab -l              # list, no finals
python scores.py ncaab ALA -l          # track ALA, skip if final
```

## Example Output

```
Tracking 'TOR' (NHL) — updates every 15s. Ctrl+C to quit.

[14:32:01] [LIVE]  TOR 2  @  BOS 3  (12:34 - 2nd)
[14:32:16] [LIVE]  TOR 2  @  BOS 3  (11:02 - 2nd)
[14:32:31] [LIVE]  TOR 3  @  BOS 3  (10:48 - 2nd)
```

Score states:

- `[LIVE]`  — game in progress
- `[PRE]`   — game not yet started
- `[FINAL]` — game completed

## Requirements

- Python 3.6+
- No third-party packages — uses stdlib only (`urllib`, `json`)
