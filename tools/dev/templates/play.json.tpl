{
  "steps": [
    "shot start",
    "tap center",
    "assert state.phase === 'playing'",
    "timescale 0.25",
    "until state.isOnBeat timeout 60",
    "tap center",
    "assert state.hits >= 1",
    "timescale 1",
    "wait 1",
    "shot playing"
  ]
}
