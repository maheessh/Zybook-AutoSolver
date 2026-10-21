# zyBooks Participation Helper v3

A JavaScript console script that automates repetitive zyBooks participation activities.

### Features
- True/False and multiple-choice questions
- Drag-and-drop matching activities
- Animations and short-answer activities
- Automatically skips completed and correct answers
- Remembers incorrect attempts and resumes unfinished activities
- Built-in progress tracking and stop control

### How to Use
1. Open your zyBooks section in Chrome.
2. Open Developer Tools (`F12` or `Cmd + Option + J`).
3. Go to **Console**, paste the JavaScript code, and press Enter.
4. The script runs automatically.

### Commands
```javascript
window.zyPA.summary();      // Check progress
window.zyPA.stop();         // Stop script
window.zyPA.clearHistory(); // Reset attempt history
```

**Note:** Designed for participation activities only, not graded challenges. Some activities may require manual review. Use only where your course permits automation.
