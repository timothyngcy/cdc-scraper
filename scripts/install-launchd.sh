#!/bin/bash
# Installs an hourly (08:00–19:00 SGT) launchd job for the CDC monitor.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.cdc.testdate-monitor"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_DIR/logs"

# Build the <StartCalendarInterval> entries: one per hour from 08:00 to 19:00.
INTERVALS=""
for H in 08 09 10 11 12 13 14 15 16 17 18 19; do
  INTERVALS+="        <dict><key>Hour</key><integer>$((10#$H))</integer><key>Minute</key><integer>0</integer></dict>
"
done

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PROJECT_DIR/scripts/run.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>
    <key>StartCalendarInterval</key>
    <array>
$INTERVALS    </array>
    <key>StandardOutPath</key>
    <string>$PROJECT_DIR/logs/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>$PROJECT_DIR/logs/launchd.err.log</string>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "Installed: $LABEL"
echo "Plist:     $PLIST"
echo "Runs at :00 from 08:00 to 19:00 local time, then waits a random 0-15 min before hitting the site."
echo
echo "Check it is loaded:  launchctl list | grep cdc"
echo "Run it now:          launchctl start $LABEL"
echo "Logs:                tail -f $PROJECT_DIR/logs/cdc.log"
