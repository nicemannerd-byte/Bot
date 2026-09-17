# BrunexBots Remote Control

Prepared for a private/test Slither-compatible server you control.

## Controls while Slither stays open
- `F` = Follow
- `W` = Wander
- `T` = Tornado
- `S` = Spiral
- `Q` = Stop

## Bot limit
`MAX_BOTS` defaults to 100 and is capped at 1000. Bots start gradually rather than all at once.

## Persistence
GitHub stores the source; it does not keep a Node process running. The included systemd service is intended for a VPS you control so the controller can restart automatically and survive SSH disconnects.

## Current limitation
The supplied project exposes the controlled player's position, but does not provide the bot manager with a reliable list of every snake/player. Therefore this build does not pretend that name-based Head Hunter/Focus is implemented yet; that requires an additional game-state feed.
