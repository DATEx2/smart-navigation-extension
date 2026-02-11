const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const imageSize = require('image-size');
const seoPreview = require('./seoPreview');
const os = require('os');
const crypto = require('crypto');
const vm = require('vm');

const outputChannel = vscode.window.createOutputChannel("Path Expander Debug");

function activate(context) {
    seoPreview.activate(context);

    // --- ID Highlighting Decorations ---
    const attributeDecorationType = vscode.window.createTextEditorDecorationType({
        color: '#0a5754', // Cyan/Greenish
        fontWeight: 'bold'
    });
    
    const categoryDecorationType = vscode.window.createTextEditorDecorationType({
        color: '#a86128', // Brownish Orange
        fontWeight: 'bold'
    });

    const lpSelfDecorationType = vscode.window.createTextEditorDecorationType({
        color: '#fff176', // Light Yellow
        fontWeight: 'bold'
    });

    const translatablePropDecorationType = vscode.window.createTextEditorDecorationType({
        color: '#c792ea', // Purple
        fontWeight: 'bold'
    });

    const missingValDecorationType = vscode.window.createTextEditorDecorationType({
        color: '#ff5555', // Red
        fontWeight: 'bold'
    });

    const validValDecorationType = vscode.window.createTextEditorDecorationType({
        color: '#50fa7b' // Green
    });

    function updateDecorations() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !['javascript', 'json'].includes(editor.document.languageId)) {
            return;
        }

        const text = editor.document.getText();
        const fileName = editor.document.fileName;
        const attributeRanges = [];
        const categoryRanges = [];
        const lpSelfRanges = [];
        const translatableRanges = [];

        // 0. Self-Referencing LP links (Yellow)
        // Extract current ID from filename: e.g. Product.12345678.js
        const currentFileIdMatch = fileName.match(/\.(\d+)\.js$/);
        const currentId = currentFileIdMatch ? currentFileIdMatch[1] : null;

        if (currentId) {
            // Match lp: 12345678 or lp: "12345678"
            const lpRegex = /\blp\s*:\s*(?:["']?)(\d+)(?:["']?)/g;
            let lpMatch;
            while ((lpMatch = lpRegex.exec(text))) {
                 if (lpMatch[1] === currentId) {
                     const startPos = editor.document.positionAt(lpMatch.index + lpMatch[0].lastIndexOf(lpMatch[1]));
                     const endPos = editor.document.positionAt(lpMatch.index + lpMatch[0].lastIndexOf(lpMatch[1]) + lpMatch[1].length);
                     lpSelfRanges.push(new vscode.Range(startPos, endPos));
                 }
            }
        }

        // 1. Attributes & ProductClass (Dark Gray)
        // Matches: "productClassId": 123 or top-level list of attribute objects { id: 123... }
        // For simple regex matching, we catch standard patterns
        
        // Match: productClassId: 123456
        const pClassRegex = /(?:["']?)productClassId(?:["']?)\s*:\s*(\d+)/g;
        let match;
        while ((match = pClassRegex.exec(text))) {
            const startPos = editor.document.positionAt(match.index + match[0].lastIndexOf(match[1]));
            const endPos = editor.document.positionAt(match.index + match[0].lastIndexOf(match[1]) + match[1].length);
            attributeRanges.push(new vscode.Range(startPos, endPos));
        }

        // Match: attributes: [ ... { id: 12345 ... ]
        // This is harder with pure regex globally. We'll iterate through occurrences of "attributes" and parse somewhat locally or just target specific "id": 123 patterns if context implies.
        // For robustness without full parser, let's look for "id": 123 patterns inside "attributes" block is tricky.
        // SIMPLIFICATION: Look for any "id": 123 pattern? No, too generic.
        // Let's assume the user format is consistent: { id: 12345, ... } inside arrays.
        // A better heuristic for attributes: standard attribute IDs are often 9 digits starting with 16, 17, 18, 20, 21, 25?? The user's types.js shows 9 digits.
        // Let's use a heuristic check: if "id": <9-digits> and followed by "name" or "type" nearby?
        // OR simply scan for `attributes: [` and then find IDs inside that block.
        
        // Trying block scanning for 'attributes'
        const attrBlockRegex = /attributes\s*:\s*\[([\s\S]*?)\]/g;
        while ((match = attrBlockRegex.exec(text))) {
            const blockStartWithPrefix = match.index;
            const blockContent = match[1];
            const blockStartOffset = match[0].indexOf(blockContent);
            const absoluteBlockStart = blockStartWithPrefix + blockStartOffset;
            
            const idRegex = /(?:["']?)\bid\b(?:["']?)\s*:\s*(\d+)/g;
            let idMatch;
            while ((idMatch = idRegex.exec(blockContent))) {
                const idVal = idMatch[1];
                const startPos = editor.document.positionAt(absoluteBlockStart + idMatch.index + idMatch[0].lastIndexOf(idVal));
                const endPos = editor.document.positionAt(absoluteBlockStart + idMatch.index + idMatch[0].lastIndexOf(idVal) + idVal.length);
                attributeRanges.push(new vscode.Range(startPos, endPos));
            }
        }
        
        // Also check if we are in types.js (where structure is different)
        if (editor.document.fileName.includes('types.js')) {
             const idRegex = /(?:["']?)\bid\b(?:["']?)\s*:\s*(\d{8,12})/g;
             while ((match = idRegex.exec(text))) {
                 const idVal = match[1];
                 // Just color all IDs in types.js as gray as they define attributes/classes? 
                 // User prompted "attributes/id and productClassId". In types.js main IDs are classes, attribute IDs are attributes.
                 const startPos = editor.document.positionAt(match.index + match[0].lastIndexOf(idVal));
                 const endPos = editor.document.positionAt(match.index + match[0].lastIndexOf(idVal) + idVal.length);
                 attributeRanges.push(new vscode.Range(startPos, endPos));
             }
        }


        // 2. Categories (Dark Orange)
        // Match: defaultCategoryId: 123456
        const defCatRegex = /(?:["']?)defaultCategoryId(?:["']?)\s*:\s*(\d+)/g;
        while ((match = defCatRegex.exec(text))) {
             const startPos = editor.document.positionAt(match.index + match[0].lastIndexOf(match[1]));
             const endPos = editor.document.positionAt(match.index + match[0].lastIndexOf(match[1]) + match[1].length);
             categoryRanges.push(new vscode.Range(startPos, endPos));
        }

        // Match: categories: [ ... { id: 12345 ... ]
        const catBlockRegex = /categories\s*:\s*\[([\s\S]*?)\]/g;
        while ((match = catBlockRegex.exec(text))) {
            const blockStartWithPrefix = match.index;
            const blockContent = match[1];
            const blockStartOffset = match[0].indexOf(blockContent);
            const absoluteBlockStart = blockStartWithPrefix + blockStartOffset;
            
            const idRegex = /(?:["']?)\bid\b(?:["']?)\s*:\s*(\d+)/g;
            let idMatch;
            while ((idMatch = idRegex.exec(blockContent))) {
                const idVal = idMatch[1];
                // Avoid highlighting "orderBy" or other nums, ensuring it's "id": ...
                const startPos = editor.document.positionAt(absoluteBlockStart + idMatch.index + idMatch[0].lastIndexOf(idVal));
                const endPos = editor.document.positionAt(absoluteBlockStart + idMatch.index + idMatch[0].lastIndexOf(idVal) + idVal.length);
                categoryRanges.push(new vscode.Range(startPos, endPos));
            }
        }

        // 3. Translatable Properties (Purple)
        // Scan for keys in profile.js and categories.js
        if (fileName.includes('profile.js') || fileName.includes('categories.js')) {
             const translatableKeys = [
                 'name', 'description', 'seoTitle', 'seoDescription',
                 'companyName', 'storeName', 'storeDescription',
                 'rootCategorySeoTitle', 'rootCategorySeoDescription',
                 'acceptMarketingCheckboxCustomText', 'orderCommentsCaption',
                 'title', 'text', 'value', 'carrier', 'deliveryTimeDays',
                 'accountName', 'accountNickName', 'brandName'
             ];
             
             // Regex to find property keys
             const keysPattern = translatableKeys.join('|');
             const keysRegex = new RegExp(`(?:["']?)\\b(${keysPattern})\\b(?:["']?)\\s*:`, 'g');
             
             let kMatch;
             while ((kMatch = keysRegex.exec(text))) {
                  const keyStr = kMatch[1];
                  const keyStartInMatch = kMatch[0].indexOf(keyStr);
                  const startPos = editor.document.positionAt(kMatch.index + keyStartInMatch);
                  const endPos = editor.document.positionAt(kMatch.index + keyStartInMatch + keyStr.length);
                  translatableRanges.push(new vscode.Range(startPos, endPos));
             }
        }

        // 4. Translation Cache Coloring (Keys & Values)
        if (fileName.endsWith('translations.ai.cache.json') || fileName.endsWith('translations.orphans.json')) {
             const invalidRanges = [];
             const validRanges = [];
             
             const langs = ['ro', 'fr', 'de', 'es', 'it', 'nl', 'da', 'sv', 'no', 'fi', 'pl', 'cs', 'sk', 'hu', 'bg', 'el', 'hr', 'sl', 'et', 'lv', 'lt', 'is', 'ar', 'ja', 'zh', 'pt'];
             const mandatoryLangs = new Set(langs);

             let currentKeyRange = null;
             let currentBlockFoundLangs = new Set();
             let inBlock = false;

             // Line-by-line parsing
             for (let i = 0; i < editor.document.lineCount; i++) {
                 const line = editor.document.lineAt(i);
                 const text = line.text;

                 // 1. Detect Main KEY Start: "Key": {
                 // Heuristic: Starts with whitespace, quote, ends with {:
                 const keyStartMatch = text.match(/^\s*"((?:[^"\\]|\\.)*)"\s*:\s*\{\s*$/);
                 if (keyStartMatch) {
                     // Found a Key start
                     const key = keyStartMatch[1];
                     
                     // Find position of the key string (quoted)
                     // Since regex matched the whole line structure, we can find the first quote
                     const firstQuoteIdx = text.indexOf('"');
                     const lastQuoteIdx = text.lastIndexOf('"', text.length - 2); // before the : {

                     if (firstQuoteIdx !== -1 && lastQuoteIdx !== -1) {
                         const range = new vscode.Range(new vscode.Position(i, firstQuoteIdx), new vscode.Position(i, lastQuoteIdx + 1));
                         currentKeyRange = range;
                         currentBlockFoundLangs = new Set();
                         inBlock = true;
                     }
                     continue;
                 }

                 if (inBlock) {
                     // 2. Detect Block End: },
                     if (text.match(/^\s*\},?\s*$/)) {
                         // End of block - Evaluate Key Completeness
                         let complete = true;
                         // Check if we have all mandatory langs
                         if (currentBlockFoundLangs.size < mandatoryLangs.size) {
                             complete = false;
                         }

                         if (currentKeyRange) {
                             if (complete) {
                                 validRanges.push(currentKeyRange);
                             } else {
                                 invalidRanges.push(currentKeyRange);
                             }
                         }

                         inBlock = false;
                         currentKeyRange = null;
                         continue;
                     }

                     // 3. Detect Language Values: "lang": "val"
                     // Regex to capture Lang and Value
                     const valMatch = text.match(/^\s*"(\w{2})"\s*:\s*"((?:[^"\\\\]|\\.)*)"/);
                     if (valMatch) {
                         const lang = valMatch[1];
                         const val = valMatch[2];
                         
                         // Determine Ranges for Highlighting the ENTRY
                         const langStartRel = text.indexOf('"' + lang + '"');
                         const langRange = new vscode.Range(new vscode.Position(i, langStartRel), new vscode.Position(i, langStartRel + lang.length + 2));
                         
                         // Value Range: defined by the value capture
                         // We need robust index finding. valMatch[0] is the whole match.
                         // The value is at the end of the match.
                         const fullMatchStr = valMatch[0];
                         const valQuoteStart = fullMatchStr.lastIndexOf('"' + val + '"'); // This approach is risky if val inside quotes?
                         // Better: lastIndexOf('"') is the closing quote.
                         const valEndIdx = fullMatchStr.lastIndexOf('"');
                         // Start index is valEndIdx - val.length - 1 (opening quote) ?? No, escapes.
                         // Safer: match indices relative to line.
                         const valStartInMatch = fullMatchStr.length - 1 - val.length; 
                         // No, fullMatchStr ends with closing quote.
                         const matchIndex = text.indexOf(fullMatchStr); // Should be reliable with indentation
                        
                         // Construct range for the Value
                         const valAbsStart = matchIndex + valStartInMatch; // approximate?
                         // Let's use specific indexes from regex if possible, but JS regex exec gives global match index.
                         // Re-running exec to get indices?
                         
                         // Let's rely on simple string searching *after* the colon.
                         const colonIdx = text.indexOf(':');
                         const valStartQuote = text.indexOf('"', colonIdx + 1);
                         const valEndQuote = text.lastIndexOf('"', text.length - 1); // might be comma at end
                         // If comma exists, last quote is before it.
                         // text.lastIndexOf('"') handle cases with trailing comma.
                         
                         if (valStartQuote !== -1) {
                             const valRange = new vscode.Range(new vscode.Position(i, valStartQuote), new vscode.Position(i, valEndQuote + 1));
                             
                             // Allow " " (space) as valid translation (meaning same as source)
                             const isValid = val && val.length > 0;
                             
                             if (mandatoryLangs.has(lang)) {
                                 if (isValid) {
                                     // validRanges.push(langRange); // User requested standard styling for keys
                                     validRanges.push(valRange);
                                     currentBlockFoundLangs.add(lang);
                                 } else {
                                     // invalidRanges.push(langRange);
                                     invalidRanges.push(valRange);
                                 }
                             } else {
                                 if (isValid) validRanges.push(valRange);
                             }
                         }
                     }
                 }
             }

             editor.setDecorations(missingValDecorationType, invalidRanges);
             editor.setDecorations(validValDecorationType, validRanges);
        }

        editor.setDecorations(attributeDecorationType, attributeRanges);
        editor.setDecorations(categoryDecorationType, categoryRanges);
        editor.setDecorations(lpSelfDecorationType, lpSelfRanges);
        editor.setDecorations(translatablePropDecorationType, translatableRanges);
    }

    // Trigger updates
    vscode.window.onDidChangeActiveTextEditor(() => {
        updateDecorations();
    }, null, context.subscriptions);

    vscode.workspace.onDidChangeTextDocument(event => {
        if (vscode.window.activeTextEditor && event.document === vscode.window.activeTextEditor.document) {
             updateDecorations();
        }
    }, null, context.subscriptions);
    
    // Initial run
    if (vscode.window.activeTextEditor) {
        updateDecorations();
    }
    // --- Translation Status Bar Logic ---
    const missingItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    let lastStats = { text: "...", color: "#FFFFFF", tooltip: "", total: 0, missing: 0 };
    context.subscriptions.push(missingItem);
    
    missingItem.text = "$(sync~spin) Initializing...";
    missingItem.tooltip = "Click to smart action";
    missingItem.show();
    // --- Active Translation Progress Bar ---
    // Combined into missingItem to ensure they are always together and valid
    
    // Command is already registered for logs: datex2.showTranslationLogs
    // missingItem command is: datex2.showMissingTranslations (shows dropdown/file jump)
    // We will keep missingItem command as is to allow jumping to missing.
    // BUT we want to see logs? Maybe a secondary click or just stick to missing jump.
    // User asked "click pe progress bar sa vedem logurile".
    // Since we combine them, we have to choose ONE command.
    // Let's use 'datex2.showMissingTranslations' as primary, but maybe we can add a new command 
    // that shows a QuickPick: "Show Logs" or "Jump to Next Missing".
    // OR simpler: separate them by a separator in text but keep same object? No, text is one clickable area.
    // Let's create a "Smart Click" command that decides what to do or shows options.
    
    context.subscriptions.push(vscode.commands.registerCommand('datex2.smartStatusBarClick', async () => {
         const rootPath = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : null;
         
         const statusFile = rootPath ? path.join(rootPath, '.agent/translation_status.json') : null;
         let isActive = false;
         if (statusFile && fs.existsSync(statusFile)) {
             try {
                 const s = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
                 isActive = s.active;
             } catch(e){}
         }

         if (isActive) {
             // If translating, show logs priority? Or ask?
             // Let's show Logs directly if active, that matches "click on progress bar".
             vscode.commands.executeCommand('datex2.showTranslationLogs');
         } else {
             // If idle, do the missing jump logic
            vscode.commands.executeCommand('datex2.showMissingTranslations');
         }
    }));

    missingItem.command = 'datex2.smartStatusBarClick';
    missingItem.priority = 1000; // High priority to stay left-most in its group

    context.subscriptions.push(vscode.commands.registerCommand('datex2.showTranslationLogs', async () => {
         const rootPath = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : null;
         if (!rootPath) return;
         
         const logPath = path.join(rootPath, '.agent/translation.log');
         if (fs.existsSync(logPath)) {
             const doc = await vscode.workspace.openTextDocument(logPath);
             await vscode.window.showTextDocument(doc); // Open log file
         } else {
             vscode.window.showInformationMessage('No translation logs found.');
         }
    }));

    function updateTranslationProgress() {
         const fs = require('fs');
         const path = require('path');
         const rootPath = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : null;
         if (!rootPath) return;
         
         const statusFile = path.join(rootPath, '.agent/translation_status.json');
         
         // Helper to get base text (missing count)
         // We need to call updateStatusBar logic but return text instead of setting it?
         // Or just read the current text of missingItem if meaningful?
         // Better: Let updateStatusBar handle the "Missing..." part, and we Append to it?
         // WRONG: updateStatusBar is async and slow-ish (reads many files). 
         // We don't want to run it every 1s if expensive.
         // But we MUST update the missing count real-time.
         // So we MUST run updateStatusBar logic. 
         
         // Let's modify updateStatusBar to accept an optional suffix argument.
         if (fs.existsSync(statusFile)) {
             try {
                 const content = fs.readFileSync(statusFile, 'utf8'); 
                 const status = JSON.parse(content);
                 
                 if (status.active) {
                     // Visual Progress Bar
                     const barLength = 10;
                     const filledLength = Math.round((status.percent / 100) * barLength);
                     const emptyLength = barLength - filledLength;
                     const barStr = '█'.repeat(filledLength) + '░'.repeat(emptyLength);
                     const progressText = `${status.current}/${status.total}`;
                     
                     const suffix = `   $(sync~spin) ${barStr} ${progressText}`;
                     
                     // Real-time update of missing count based on progress
                     // lastStats.missing is the base count. status.current is items done.
                     // status.active means we are progressing.
                     // Note: status.current resets per run? Yes.
                     // But lastStats might be old if we didn't scan recently.
                     // Assuming lastStats was accurate before start or updated via file save events.
                     
                     let projectedMissing = lastStats.missing;
                     let projectedPercent = 0;
                     
                     if (lastStats.total > 0) {
                        // If we are translating, "current" items are now NOT missing (or at least processed)
                        // But wait, status.current includes SKIPPED items?
                        // The user said: "știm exact câte s-au terminat".
                        // status.current increments for every key processed.
                        // So projectedMissing = lastStats.missing - status.current?
                        // Roughly yes.
                        projectedMissing = Math.max(0, lastStats.missing - status.current);
                        projectedPercent = Math.round(((lastStats.total - projectedMissing) / lastStats.total) * 100);
                     } else {
                        // Fallback parsing if numbers missing
                        try {
                            const parts = lastStats.text.match(/(\d+)\s*\((\d+)%\)/);
                            if (parts) {
                                const base = parseInt(parts[1]);
                                projectedMissing = Math.max(0, base - status.current);
                                // percent is harder without total.
                                projectedPercent = parts[2]; // keep old percent approx?
                            }
                        } catch(e){}
                     }

                     let currentItemSnippet = "";
                     try {
                         // lastLog format: "Translating item X/Y (KEY...)"
                         const m = status.lastLog.match(/\((.*?)\)$/);
                         if (m && m[1]) {
                             currentItemSnippet = m[1];
                         } else {
                             // Fallback if format is different
                             currentItemSnippet = status.lastLog; 
                         }

                         // CLEANUP: User requested to remove filenames/paths
                         if (currentItemSnippet.includes('file:') || currentItemSnippet.includes('/') || currentItemSnippet.includes('\\')) {
                             currentItemSnippet = "";
                         }

                         if (currentItemSnippet.length > 20) { // 15 chars requested, giving 20 to be safe/readable
                             currentItemSnippet = currentItemSnippet.substring(0, 20) + '..';
                         }
                     } catch(e) {}

                     const missingText = `${projectedMissing} left / ${lastStats.total}`;
                     // "în față" -> Leftmost
                     // Format: "KEY_SNIPPET   MISSING   $(icon) BAR  CUR/TOT"
                     
                     // DIRECT UPDATE to bypass updateStatusBar async/disabled logic
                     // User wants: "Translating...", Progress Bar, Spinner, and "N left / M"
                     // Format: "$(sync~spin) Translating... [BAR] N left / M"
                     
                     missingItem.text = `$(sync~spin) Translating... ${barStr} ${missingText}`;
                     missingItem.tooltip = `Translating... ${status.percent}%\nDone: ${status.current}/${status.total}\nBase Missing: ${lastStats.missing}`;
                     missingItem.color = '#FFA500'; 
                     missingItem.show();
                 } else {
                     // Revert using standard update
                     updateStatusBar(null);
                 }
             } catch (e) { 
                 // If error, ignore
             }
         } else {
             updateStatusBar(null);
         }
    }

    // Use polling instead of watcher for reliability with dotfiles
    const pollingInterval = 1000;
    const pollingTimer = setInterval(() => {
        try {
            updateTranslationProgress();
        } catch (e) { console.error('Polling error:', e); }
    }, pollingInterval);
    
    context.subscriptions.push({ dispose: () => clearInterval(pollingTimer) });
    
    // Initial check
    updateStatusBar().then(() => {
        updateTranslationProgress();
    });

    // Helper to extract missing entries from content
    function getMissingEntries(content) {
        const entries = [];
        // Keys that need translation
        const baseKeys = ['name', 'seoTitle', 'seoDescription', 'description', 'text', 'value'];
        const keysPatternStr = `(?:\\w*Translated)|${baseKeys.join('|')}`;
        // Regex to find keys: key: "value" or "key": "value"
        // Captures: 1=Key, 2=Quote, 3=Value
        const keyPattern = new RegExp(`(?:^|\\s|,|{)(?:["']?)(${keysPatternStr})(?:["']?)\\s*:\\s*(["'])((?:(?!\\2)[^\\\\]|\\\\.)*?)\\2`, 'g');
        const loadPattern = /load\(\s*(["'])((?:(?!\1)[^\\]|\\.)*?)\1\s*\)/g;

        let match;
        while ((match = keyPattern.exec(content)) !== null) {
            const quote = match[2];
            const val = match[3];
            if (!val.endsWith(' ') && val.length > 0) {
                // Determine start position using length from end (robust for escaped quotes)
                // match[0] ends with the closing quote \2
                // val is immediately before that closing quote
                // so val start is: matchEnd - 1 (quote) - valLength
                const valStartRel = match[0].length - 1 - val.length;
                const absStart = match.index + valStartRel;
                entries.push({ start: absStart, end: absStart + val.length, val });
            }
        }

        while ((match = loadPattern.exec(content)) !== null) {
            const quote = match[1];
            const val = match[2];
            if (!val.endsWith(' ') && val.length > 0) {
                // For load(), the first quote is the opening one
                const valStartInMatch = match[0].indexOf(quote) + 1;
                const absStart = match.index + valStartInMatch;
                entries.push({ start: absStart, end: absStart + val.length, val });
            }
        }
        return entries.sort((a,b) => a.start - b.start);
    }

    async function updateStatusBar(suffix) {
        // Guard: invalid suffix (e.g. Uri object from file watcher) -> clear it
        if (typeof suffix !== 'string' || suffix.startsWith('file:') || suffix.includes('/') || suffix.includes('\\')) {
            suffix = null;
        }

        // User requested to ONLY show Cache stats in Status Bar.
        // Scanning product files is deactivated for the status bar count to avoid confusion 
        // with unsaved/unfetched local file changes.
        
        let total = 0;
        let missing = 0;

        // Populate global map for fast lookups (refs) - CRITICAL for Ctrl+Click
        const productFiles = await vscode.workspace.findFiles('db/products/**/*.js', '**/node_modules/**');
        
        global.datex2ProductMap = {};
        for (const file of productFiles) {
            const name = path.basename(file.fsPath, '.js');
            global.datex2ProductMap[name] = file.fsPath;
            // Handle SKU.id.js -> map SKU to it if not present (heuristic)
            if (name.match(/\.\d+$/)) {
                const sku = name.substring(0, name.lastIndexOf('.'));
                if (!global.datex2ProductMap[sku]) {
                     global.datex2ProductMap[sku] = file.fsPath;
                }
            }
        }

        // Check cache file FIRST (Global stats)
        let cacheMissing = 0;
        let cacheTotal = 0;
        
        try {
            const rootPath = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
                ? vscode.workspace.workspaceFolders[0].uri.fsPath
                : '';
                
            if (rootPath) {
                const cachePath = path.join(rootPath, 'db/translations/translations.ai.cache.json');
                if (fs.existsSync(cachePath)) {
                    const cacheContent = fs.readFileSync(cachePath, 'utf8');
                    const cacheJson = JSON.parse(cacheContent);
                    const keys = Object.keys(cacheJson);
                    
                    const targetLangs = ['ro', 'fr', 'de', 'es', 'it', 'nl', 'da', 'sv', 'no', 'fi', 'pl', 'cs', 'sk', 'hu', 'bg', 'el', 'hr', 'sl', 'et', 'lv', 'lt', 'is', 'ar', 'ja', 'zh', 'pt'];

                    cacheTotal = keys.length * targetLangs.length;
                    
                    let mCount = 0;
                    for (const k of keys) {
                        const v = cacheJson[k];
                        if (!v || typeof v !== 'object') {
                             mCount += targetLangs.length;
                             continue;
                        }
                        
                        for (const lang of targetLangs) {
                            const val = v[lang];
                            // Check if missing or NO trailing space (convention for finished translation)
                            if (!val || typeof val !== 'string' || !val.endsWith(' ')) {
                                mCount++;
                            }
                        }
                    }
                    cacheMissing = mCount;
                }
            }
        } catch (e) { console.error('Error reading translation cache:', e); }
        
        const combinedTotal = total + cacheTotal;
        const combinedMissing = missing + cacheMissing;
        
        let barStr = '';
        if (combinedMissing > 0 && combinedTotal > 0) {
            const pct = Math.round(((combinedTotal - combinedMissing) / combinedTotal) * 100);
            const filled = Math.round((pct / 100) * 10);
            barStr = '█'.repeat(filled) + '░'.repeat(10 - filled);
        }

        lastStats.text = combinedMissing === 0 
            ? `Done! (${combinedTotal})` 
            : `$(sync~spin) Translating... ${barStr} ${combinedMissing} left / ${combinedTotal}`; 

        lastStats.color = combinedMissing === 0 ? '#00FF00' : '#FFA500';
        lastStats.tooltip = `Cache: ${cacheMissing} missing / ${cacheTotal} terms`;
        lastStats.total = combinedTotal;
        lastStats.missing = combinedMissing;

        // --- GUARD: If translation is actively running, do NOT touch the status bar visuals.
        // updateTranslationProgress() (polling every 1s) is the sole owner of the UI during translation.
        // Without this guard, cacheWatcher.onDidChange triggers updateStatusBar which overwrites
        // the "Translating..." + progress bar text, causing a brief flicker/disappearance.
        // We still updated lastStats above so updateTranslationProgress has fresh numbers.
        try {
            const rootPath2 = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
                ? vscode.workspace.workspaceFolders[0].uri.fsPath
                : null;
            if (rootPath2) {
                const statusFile = path.join(rootPath2, '.agent/translation_status.json');
                if (fs.existsSync(statusFile)) {
                    const statusContent = fs.readFileSync(statusFile, 'utf8');
                    const status = JSON.parse(statusContent);
                    if (status.active) {
                        // Translation is running - skip visual update, let polling handle it
                        return;
                    }
                }
            }
        } catch (e) { /* If status file is unreadable, fall through to normal update */ }

        // --- Normal visual update (only when translation is NOT active) ---
        if (suffix !== undefined && suffix !== null) {
            missingItem.text = `$(sync~spin) ${combinedMissing} left / ${combinedTotal}`;
            missingItem.color = '#FFA500';
        } else {
             if (combinedMissing > 0) {
                 missingItem.text = `$(sync~spin) ${combinedMissing} left / ${combinedTotal}`;
                 missingItem.color = '#FFA500';
             } else {
                 missingItem.text = lastStats.text;
                 missingItem.color = lastStats.color;
             }
        }
        
        missingItem.tooltip = lastStats.tooltip + (suffix ? `\nStatus: ${suffix}` : '');
        missingItem.show();
    }

    // Helper for cache missing entries (keys with no trailing space)
    function getMissingCacheEntries(content) {
        const entries = [];
        
        // 1. Check Top-Level Keys (Lines like "Key": { )
        const keysRegex = /"((?:[^"\\]|\\.)*)"\s*:\s*\{/g;
        let match;
        while ((match = keysRegex.exec(content)) !== null) {
            const key = match[1];
            if (!key.endsWith(' ')) {
                const start = match.index + 1; 
                const end = start + key.length;
                entries.push({ start, end, val: key });
            }
        }

        // 2. Check Values (Lines like "lang": "Value")
        // Exclude 'cy' and 'refs'
        const valuesRegex = /"([^"\\]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
        while ((match = valuesRegex.exec(content)) !== null) {
            const prop = match[1];
            const val = match[2];
            
            if (prop === 'cy' || prop === 'refs') continue;

            if (!val.endsWith(' ')) {
                 // Determine value location
                 const colonIdx = match[0].indexOf(':');
                 const valQuoteStart = match[0].indexOf('"', colonIdx + 1);
                 const valStartInMatch = valQuoteStart + 1;
                 
                 const start = match.index + valStartInMatch;
                 const end = start + val.length;
                 entries.push({ start, end, val: val });
            }
        }
        
        return entries.sort((a,b) => a.start - b.start);
    }

    context.subscriptions.push(vscode.commands.registerCommand('datex2.showMissingTranslations', async () => {
        // Find ALL product files, sort them
        const productFiles = (await vscode.workspace.findFiles('db/products/**/*.js', '**/node_modules/**'))
            .sort((a, b) => a.fsPath.localeCompare(b.fsPath));
        
        // Append cache file if exists
        const rootPath = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : null;
        if (rootPath) {
            const cachePath = path.join(rootPath, 'db/translations/translations.ai.cache.json');
            if (fs.existsSync(cachePath)) {
                productFiles.push(vscode.Uri.file(cachePath));
            }
        }

        if (productFiles.length === 0) return;

        const editor = vscode.window.activeTextEditor;
        let startFileIndex = 0;
        let startOffset = -1;

        if (editor) {
            const currentPath = editor.document.fileName;
            const exactIdx = productFiles.findIndex(f => f.fsPath === currentPath);

            if (exactIdx !== -1) {
                startFileIndex = exactIdx;
                startOffset = editor.document.offsetAt(editor.selection.active);
            } else {
                // Detect based on folder: Find product file that is in a parent directory of current file
                // But skip this logic if we are in cache file (already handled by exactIdx usually, or falls through)
                if (!currentPath.endsWith('translations.ai.cache.json')) {
                    const matches = productFiles.map((f, i) => ({ i, dir: path.dirname(f.fsPath) }))
                        .filter(m => currentPath.startsWith(m.dir + path.sep) || currentPath === m.dir);
                    
                    if (matches.length > 0) {
                        // Sort by length desc to get deepest matching folder (closest parent)
                        matches.sort((a, b) => b.dir.length - a.dir.length);
                        startFileIndex = matches[0].i;
                        startOffset = -1; // Start from the beginning of the file
                    }
                }
            }
        }

        // Loop files starting from current
        for (let i = 0; i < productFiles.length; i++) {
            // Logic to wrap around: (start + i) % length
            const fileIdx = (startFileIndex + i) % productFiles.length;
            const file = productFiles[fileIdx];
            
            const isCacheFile = file.fsPath.endsWith('translations.ai.cache.json');
            const content = fs.readFileSync(file.fsPath, 'utf8');
            const entries = isCacheFile ? getMissingCacheEntries(content) : getMissingEntries(content);
            
            if (entries.length === 0) continue;

            let targetEntry = null;

            if (fileIdx === startFileIndex) {
               
                // Simplest: Find first entry > startOffset.
                targetEntry = entries.find(e => e.start > startOffset);
            } else {
                targetEntry = entries[0];
            }

            if (targetEntry) {
                // Found one!
                const doc = await vscode.workspace.openTextDocument(file);
                const ed = await vscode.window.showTextDocument(doc);
                const pos = ed.document.positionAt(targetEntry.start);
                // Select the content
                const endPos = ed.document.positionAt(targetEntry.end);
                ed.selection = new vscode.Selection(pos, endPos);
                ed.revealRange(new vscode.Range(pos, endPos), vscode.TextEditorRevealType.InCenter);
                return;
            }
        }
        
        // If we only looped once, we missed the start of the start file.
        // Check start of start file
        if (startOffset > -1) {
             const file = productFiles[startFileIndex];
             const isCacheFile = file.fsPath.endsWith('translations.ai.cache.json');
             const content = fs.readFileSync(file.fsPath, 'utf8');
             const entries = isCacheFile ? getMissingCacheEntries(content) : getMissingEntries(content);
             
             // Wrap around check: Find first entry (lowest offset)
             if (entries.length > 0) {
                 const targetEntry = entries[0];
                 const doc = await vscode.workspace.openTextDocument(file);
                 const ed = await vscode.window.showTextDocument(doc);
                 const pos = ed.document.positionAt(targetEntry.start);
                 const endPos = ed.document.positionAt(targetEntry.end);
                 ed.selection = new vscode.Selection(pos, endPos);
                 ed.revealRange(new vscode.Range(pos, endPos), vscode.TextEditorRevealType.InCenter);
                 return;
             }
        }


        vscode.window.showInformationMessage('No missing translations found!');
    }));

    // --- Boldify / Unboldify Logic (UTF-8 Mathematical Sans-Serif Bold) ---
    function toBold(text) {
        return Array.from(text).map(char => {
            const cp = char.codePointAt(0);
            if (cp >= 0x41 && cp <= 0x5A) return String.fromCodePoint(cp + 119743);
            if (cp >= 0x61 && cp <= 0x7A) return String.fromCodePoint(cp + 119737);
            if (cp >= 0x30 && cp <= 0x39) return String.fromCodePoint(cp + 120734);
            return char;
        }).join('');
    }

    function fromBold(text) {
        return Array.from(text).map(char => {
            const cp = char.codePointAt(0);
            if (cp >= 0x1D400 && cp <= 0x1D419) return String.fromCodePoint(cp - 119743);
            if (cp >= 0x1D41A && cp <= 0x1D433) return String.fromCodePoint(cp - 119737);
            if (cp >= 0x1D7CE && cp <= 0x1D7D7) return String.fromCodePoint(cp - 120734);
            return char;
        }).join('');
    }

    function isBold(text) {
        let hasBold = false;
        for (const char of text) {
            const cp = char.codePointAt(0);
            // If contains any normal alphanumeric char, it's not "fully" bold
            if ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A) || (cp >= 0x30 && cp <= 0x39)) {
                return false;
            }
            // If contains bold alphanumeric char
            if ((cp >= 0x1D400 && cp <= 0x1D419) || (cp >= 0x1D41A && cp <= 0x1D433) || (cp >= 0x1D7CE && cp <= 0x1D7D7)) {
                hasBold = true;
            }
        }
        return hasBold;
    }

    function performBoldAction(type) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        editor.edit(editBuilder => {
            editor.selections.forEach(selection => {
                const text = editor.document.getText(selection);
                if (!text) return;

                let newText = text;
                const boldCheck = isBold(text);

                if (type === 'on') {
                     newText = toBold(text);
                } else if (type === 'off') {
                     newText = fromBold(text);
                } else {
                     // Toggle
                     if (boldCheck) {
                         newText = fromBold(text);
                     } else {
                         newText = toBold(text);
                     }
                }
                
                if (newText !== text) {
                    editBuilder.replace(selection, newText);
                }
            });
        });
    }

    context.subscriptions.push(vscode.commands.registerCommand('datex2.boldify', () => performBoldAction('on')));
    context.subscriptions.push(vscode.commands.registerCommand('datex2.unboldify', () => performBoldAction('off')));
    context.subscriptions.push(vscode.commands.registerCommand('datex2.toggleBoldify', () => performBoldAction('toggle')));

    // --- Toggle Translation / Product File Logic ---
    let lastProductEditorUri = null;

    context.subscriptions.push(vscode.commands.registerCommand('datex2.toggleTranslationFile', async () => {
        try {
            console.log('DATEx2: toggleTranslationFile triggered');
            const editor = vscode.window.activeTextEditor;
            const rootPath = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
                ? vscode.workspace.workspaceFolders[0].uri.fsPath
                : null;
            
            if (!rootPath) return;
            const cachePath = path.join(rootPath, 'db/translations/translations.ai.cache.json');

            if (!editor) return;

            const document = editor.document;
            const filePath = document.fileName;
            
            // --- Helper: Get Key from line "key": "val" ---
            const getKeyVal = (lineText) => {
                const match = lineText.match(/^\s*(["'])((?:(?!\1)[^\\]|\\.)*?)\1\s*:\s*(["'])((?:(?!\3)[^\\]|\\.)*?)\3/);
                if (match) return { key: match[2], val: match[4] };
                // Also match simple objects like { lp: ..., text: "..." }
                // This is harder with regex, but let's try to find "text": "..."
                const textMatch = lineText.match(/(?:^|,\s*)text\s*:\s*(["'])((?:(?!\1)[^\\]|\\.)*?)\1/);
                if (textMatch) return { key: 'text', val: textMatch[2] };
                
                return { key: null, val: null };
            };

            if (filePath.toLowerCase() === cachePath.toLowerCase()) {
                // We are in cache file, switch back
                if (!lastProductEditorUri) {
                     vscode.window.showErrorMessage('No previous file to return to.');
                     return; 
                }

                // Reverse Navigation: Cycle through refs
                // 1. Identify current key in cache file
                const selection = editor.selection.active;
                // Find containing key -> search upwards for "KEY": {
                let keyLine = selection.line;
                let keyText = null;
                
                // Scan upwards to find the key line
                while (keyLine >= 0) {
                    const lineText = document.lineAt(keyLine).text;
                     // Regex for "KEY": {
                    const match = lineText.match(/^\s*"((?:[^"\\]|\\.)*)"\s*:\s*\{/);
                    if (match) {
                        keyText = match[1];
                        break;
                    }
                    // Stop if we hit end of another object "}," (but careful with nested objects)
                    // If indentation decreases, we might have gone too far up?
                    // Simplified: Just match "KEY": {
                    keyLine--;
                }

                if (!keyText) {
                    // Fallback to simple jump back
                    try {
                        const doc = await vscode.workspace.openTextDocument(lastProductEditorUri);
                        await vscode.window.showTextDocument(doc);
                    } catch (e) { vscode.window.showErrorMessage('Could not open previous file.'); }
                    return;
                }

                // 2. Parse cache JSON to find refs for this key
                // Since JSON is huge, we should parse just this block or use regex to find "refs": [ ... ]
                // under this key.
                const text = document.getText();
                // Find "refs": [ ... ] after the keyLine
                const keyIndex = document.offsetAt(new vscode.Position(keyLine, 0));
                // Limit search window
                const searchWindow = text.substring(keyIndex, keyIndex + 5000); 
                
                // Extract refs array content match
                const refsMatch = searchWindow.match(/"refs"\s*:\s*\[([\s\S]*?)\]/);
                
                let targetUri = lastProductEditorUri;
                let targetSelection = null;

                if (refsMatch) {
                    const refsContent = refsMatch[1];
                    // Parse strings inside
                    const refStrings = [];
                    const refRegex = /"([^"]+)"/g;
                    let m;
                    while ((m = refRegex.exec(refsContent)) !== null) {
                        refStrings.push(m[1]);
                    }
                    
                    if (refStrings.length > 0) {
                        // Strategy: Cycle through refs
                        if (!global.datex2RefIndex) global.datex2RefIndex = {};
                        
                        let currentIndex = global.datex2RefIndex[keyText];
                        
                        // If we have a last known product/location, try to find it in refs to sync cycle
                        if (lastProductEditorUri) {
                            // Find ref matching lastProductEditorUri (and line if possible)
                            // Ref format: product://SKU@Line:Col/Path
                            // We need to match SKU (from URI) and Line (from selection)
                            
                            // Extract SKU from last URI
                            // Path: .../db/products/.../SKU/SKU.js or SKU.ID.js
                            const fsPath = lastProductEditorUri.fsPath;
                            const pathParts = fsPath.split(path.sep);
                            // SKU is likely the parent folder name or filename base
                            // Try to match against refs
                            
                            for (let i = 0; i < refStrings.length; i++) {
                                const r = refStrings[i];
                                // Parse ref to get SKU and Line
                                const at = r.indexOf('@');
                                if (at === -1) continue;
                                
                                const refProtocol = 'product:';
                                let sStart = r.indexOf(refProtocol);
                                if (sStart !== -1) {
                                    sStart += refProtocol.length;
                                    if (r.indexOf('//', sStart) === sStart) sStart += 2;
                                } else {
                                    sStart = 0; // Fallback
                                }
                                
                                const rSku = r.substring(sStart, at);
                                
                                // Line
                                const loc = r.substring(at+1);
                                const slash = loc.indexOf('/');
                                if (slash === -1) continue;
                                const lineStr = loc.substring(0, loc.indexOf(':'));
                                const rLine = parseInt(lineStr);
                                
                                // Check if fsPath includes SKU (simple check)
                                // And line matches lastProductEditorSelection.line + 1
                                if (lastProductEditorSelection && fsPath.includes(rSku) && (Math.abs(rLine - (lastProductEditorSelection.line + 1)) <= 1)) {
                                    // Found match! Use this index as current
                                    currentIndex = i;
                                    break;
                                }
                            }
                            // Clear it so next cycle uses increment
                            lastProductEditorUri = null; 
                            lastProductEditorSelection = null;
                        }

                        if (currentIndex === undefined || currentIndex === -1) currentIndex = -1;
                        currentIndex = (currentIndex + 1) % refStrings.length; 
                        
                        global.datex2RefIndex[keyText] = currentIndex;
                        
                        const ref = refStrings[currentIndex];
                        
                        // Parse ref: product://SKU@Line:Col/JsonPath#HtmlPath or product://SKU@Line:Col/JsonPath
                        const atSplit = ref.indexOf('@');
                        if (atSplit !== -1) {
                            const locationPart = ref.substring(atSplit + 1);
                            
                            // Find split between Line:Col and Path
                            const firstSlash = locationPart.indexOf('/');
                            
                            if (firstSlash !== -1) {
                                const lineCol = locationPart.substring(0, firstSlash);
                                const remainder = locationPart.substring(firstSlash + 1);

                                const [lineStr, colStr] = lineCol.split(':');
                                let line = parseInt(lineStr);
                                let col = parseInt(colStr);
                                
                                const refProtocol = 'product:';
                                let skuStart = ref.indexOf(refProtocol);
                                if (skuStart !== -1) {
                                    skuStart += refProtocol.length;
                                    // Handle 'product://' case
                                    if (ref.substring(skuStart, skuStart + 2) === '//') {
                                        skuStart += 2;
                                    }
                                } else {
                                    // Fallback or error? Assume start
                                    skuStart = 0;
                                }

                                const skuPart = ref.substring(skuStart, atSplit); 
                                
                                // We must search for the file as it can be nested in categories
                                const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
                                
                                // Optimized search: Check know paths first if possible?
                                // No, just use findFiles.
                                
                                let targetFileUri = null;
                                const hashSplit = remainder.indexOf('#');
                                
                                if (hashSplit !== -1) {
                                     // HTML ref: path is after hash
                                     // Assuming the path after # is relative to the product folder? 
                                     // Or is it the filename?
                                     // Let's assume finding the SKU folder is key.
                                     const relativeHtml = remainder.substring(hashSplit + 1);
                                     
                                     // Find SKU folder first
                                     // Search for SKU.js to locate folder
                                     const jsFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(root, `db/products/**/${skuPart}.js`), null, 1);
                                     let skuDir = null;
                                     if (jsFiles.length > 0) {
                                         skuDir = path.dirname(jsFiles[0].fsPath);
                                     } else {
                                         // try SKU.*.js
                                         const jsFiles2 = await vscode.workspace.findFiles(new vscode.RelativePattern(root, `db/products/**/${skuPart}.*.js`), null, 1);
                                         if (jsFiles2.length > 0) skuDir = path.dirname(jsFiles2[0].fsPath);
                                     }
                                     
                                     if (skuDir) {
                                         // Construct absolute path for HTML
                                         // relativeHtml might be "subdir/file.html" or just "file.html"
                                         const absPath = path.join(skuDir, relativeHtml);
                                         if (fs.existsSync(absPath)) {
                                             targetFileUri = vscode.Uri.file(absPath);
                                         } else {
                                             // Fallback: maybe relativeHtml is just the name?
                                             // Try joining
                                         }
                                     }
                                } else {
                                     // JS Ref
                                     // Search for db/products/**/SKU.js
                                     const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root, `db/products/**/${skuPart}.js`), null, 1);
                                     
                                     if (files.length > 0) {
                                         targetFileUri = files[0];
                                     } else {
                                         // Search for db/products/**/SKU.*.js (e.g. SKU.ID.js)
                                         const files2 = await vscode.workspace.findFiles(new vscode.RelativePattern(root, `db/products/**/${skuPart}.*.js`), null, 1);
                                         if (files2.length > 0) {
                                             targetFileUri = files2[0];
                                         }
                                     }
                                }
                                
                                if (targetFileUri) {
                                    targetUri = targetFileUri;
                                } else {
                                    vscode.window.showErrorMessage(`Could not populate ref: File for ${skuPart} not found in db/products.`);
                                    return; // Stop processing this ref
                                }
                                
                                // Restore horizontal position offset if possible
                                const currentPos = editor.selection.active;
                                const currentLineText = editor.document.lineAt(currentPos.line).text;
                                // Find where key starts in this line ("Key": {)
                                const keyStart = currentLineText.indexOf('"');
                                let offset = 0;
                                if (keyStart !== -1 && currentPos.character > keyStart) {
                                    offset = currentPos.character - (keyStart + 1); // +1 for quote
                                    if (offset < 0) offset = 0;
                                }
                                
                                // Apply offset to target Col
                                col = col + offset;
                                
                                targetSelection = new vscode.Position(line - 1, col - 1);
                            }
                        }
                    }
                }
                
                try {
                     const doc = await vscode.workspace.openTextDocument(targetUri);
                     const ed = await vscode.window.showTextDocument(doc);
                     if (targetSelection) {
                         ed.selection = new vscode.Selection(targetSelection, targetSelection);
                         ed.revealRange(new vscode.Range(targetSelection, targetSelection), vscode.TextEditorRevealType.InCenter);
                     }
                } catch(e) {
                     vscode.window.showErrorMessage('Could not follow ref: ' + e.message);
                }
            } else {
                // We are in source, switch to cache
                if (editor) {
                    lastProductEditorUri = editor.document.uri;
                    lastProductEditorSelection = editor.selection.active;
                }
                
                if (!fs.existsSync(cachePath)) {
                    vscode.window.showErrorMessage('Translation cache file not found.');
                    return;
                }

                // 1. Identify text to search
                const selection = editor.selection.active;
                const lineIdx = selection.line;
                const currentLineText = document.lineAt(lineIdx).text;
                
                let searchText = null;
                
                // Try to extract string under cursor first
                const wordRange = document.getWordRangeAtPosition(selection, /(["'])((?:(?!\1)[^\\]|\\.)*?)\1/);
                if (wordRange) {
                    const text = document.getText(wordRange);
                    // Strip quotes
                    searchText = text.substring(1, text.length - 1);
                } else {
                     // Try to parse line for value
                     const kv = getKeyVal(currentLineText);
                     if (kv.val) searchText = kv.val;
                }

                const doc = await vscode.workspace.openTextDocument(cachePath);
                
                if (searchText) {
                     // 2. Search in cache file
                     // Cache keys are the text itself (usually English text)
                     
                     // Helper: Find exact key in JSON
                     const findKeyOffset = (text, keysToFind) => {
                         for (const key of keysToFind) {
                             const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                             // Look for "KEY": start of object
                             const regex = new RegExp(`^\\s*"${escaped}"\\s*:`, 'm');
                             const match = regex.exec(text);
                             if (match) return match.index;
                         }
                         return -1;
                     };
                     
                     const cacheContent = doc.getText();
                     // Try: exact, trimmed, trimmed + space
                     const candidates = [searchText, searchText.trim(), searchText.trim() + " "];
                     // Deduplicate
                     const uniqueCandidates = [...new Set(candidates)];
                     
                     const foundOffset = findKeyOffset(cacheContent, uniqueCandidates);
                     
                     const targetEditor = await vscode.window.showTextDocument(doc);
                     
                     if (foundOffset !== -1) {
                         const pos = doc.positionAt(foundOffset);
                         // Select the line or just the key?
                         // Let's select the key string
                         const lineText = doc.lineAt(pos.line).text;
                         const keyStart = lineText.indexOf('"');
                         if (keyStart !== -1) {
                              const keyEnd = lineText.indexOf('"', keyStart + 1);
                              if (keyEnd !== -1) {
                                  // Select the key content
                                  const startPos = new vscode.Position(pos.line, keyStart + 1);
                                  const endPos = new vscode.Position(pos.line, keyEnd);
                                  targetEditor.selection = new vscode.Selection(startPos, endPos);
                              } else {
                                  targetEditor.selection = new vscode.Selection(pos, pos);
                              }
                         } else {
                              targetEditor.selection = new vscode.Selection(pos, pos);
                         }
                         
                         targetEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                     } else {
                         vscode.window.showInformationMessage(`Translation entry "${searchText}" not found in cache.`);
                     }
                } else {
                    await vscode.window.showTextDocument(doc);
                }
            }
        } catch (e) {
            console.error(e);
            vscode.window.showErrorMessage("Error in toggleTranslationFile: " + e.message);
        }
    }));



    // Initial update
    updateStatusBar();
    
    // Watch for saves

    // --- Cache Ref Update Logic ---
    // --- TOKENIZER & PARSER HELPERS ---
    function tokenize(text) {
        const tokens = [];
        const regex = /(\/\/.*)|(\/\*[\s\S]*?\*\/)|([{}\[\]:,])|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|([a-zA-Z_$][\w$]*)|(\(|\))/g;
        
        let match;
        let line = 1;
        let col = 1;
        let lastIndex = 0;
    
        const advance = (idx) => {
            while (lastIndex < idx) {
                if (text[lastIndex] === '\n') {
                    line++;
                    col = 1;
                } else {
                    col++;
                }
                lastIndex++;
            }
        };
    
        while ((match = regex.exec(text)) !== null) {
            advance(match.index);
            const type = match[1] || match[2] ? 'Comment' : match[3] ? 'Punct' : match[4] ? 'String' : match[5] ? 'Ident' : match[6] ? 'Paren' : 'Unknown';
            const val = match[0];
            let tempL = line;
            let tempC = col;
            for (let char of val) {
                if (char === '\n') { tempL++; tempC = 1; }
                else tempC++;
            }
            if (type !== 'Comment') tokens.push({ type, val, line, col });
            line = tempL; col = tempC; lastIndex += val.length;
        }
        return tokens;
    }

    function parse(tokens) {
        let current = 0;
        function walk() {
            if (current >= tokens.length) return null;
            let token = tokens[current];
            
            if (token.val === '{') {
                current++;
                const node = { type: 'Object', properties: [], start: token };
                while (current < tokens.length && tokens[current].val !== '}') {
                    const prop = walkProperty();
                    if (prop) node.properties.push(prop);
                    if (tokens[current] && tokens[current].val === ',') current++;
                }
                current++; return node;
            }
            if (token.val === '[') {
                current++;
                const node = { type: 'Array', elements: [], start: token };
                while (current < tokens.length && tokens[current].val !== ']') {
                    const elem = walk();
                    if (elem) node.elements.push(elem);
                    if (tokens[current] && tokens[current].val === ',') current++;
                }
                current++; return node;
            }
            if (token.type === 'Ident' && token.val === 'load') {
                current++;
                if (tokens[current] && tokens[current].val === '(') {
                    current++; const arg = walk(); current++; // skip )
                    return { type: 'Call', callee: 'load', arguments: [arg], start: token };
                }
            }
            if (token.type === 'String' || token.type === 'Ident') { // Ident can be value
                current++;
                return { type: 'Literal', val: token.val, raw: token.val, start: token };
            }
            // Avoid consuming closing delimiters if we are lost
            if (token.val === '}' || token.val === ']' || token.val === ')' || token.val === ',') {
                return null;
            }
            current++;
            return null;
        }
        function walkProperty() {
            if (current >= tokens.length) return null;
            if (tokens[current].val === '}') return null;
            let keyToken = tokens[current];
            if (current + 1 < tokens.length && tokens[current+1].val === ':') {
                current++; current++;
                const value = walk();
                return { type: 'Property', key: keyToken.val.replace(/['"]/g, ''), value: value, start: keyToken };
            }
            return null;
        }
        while(current < tokens.length && tokens[current].val !== '{') current++;
        if (current < tokens.length) return walk();
        return null;
    }

    function traverseAndCollect(node, pathStack, results, resolveName) {
        if (!node) return;
        if (node.type === 'Object') {
            let name = null;
            if (resolveName) {
                const nameProp = node.properties.find(p => p.key === 'name');
                const textProp = node.properties.find(p => p.key === 'text');
                if (nameProp && nameProp.value.type === 'Literal') name = nameProp.value.val.replace(/['"]/g, '').trim();
                else if (textProp && textProp.value.type === 'Literal') name = textProp.value.val.replace(/['"]/g, '').trim();
            }
            let myPathStack = [...pathStack];
            if (name && resolveName) { myPathStack.pop(); myPathStack.push(name); }
            node.properties.forEach(prop => traverseAndCollect(prop, myPathStack, results, false));
        } else if (node.type === 'Array') {
            node.elements.forEach((elem, index) => traverseAndCollect(elem, [...pathStack, index.toString()], results, true));
        } else if (node.type === 'Property') {
            traverseAndCollect(node.value, [...pathStack, node.key], results, false);
        } else if (node.type === 'Literal') {
            const str = node.val;
            if (str.startsWith("'") || str.startsWith('"')) {
                const content = str.substring(1, str.length - 1);
                if (content.endsWith(' ') || content === ' ') {
                    results.push({ key: content, line: node.start.line, col: node.start.col, path: pathStack.join('/') });
                }
            }
        } else if (node.type === 'Call' && node.callee === 'load') {
            const arg = node.arguments[0];
            if (arg && arg.type === 'Literal') {
                const quotedPath = arg.val;
                const relPath = quotedPath.substring(1, quotedPath.length - 1);
                results.push({ isLoad: true, htmlPath: relPath, line: node.start.line, col: node.start.col, path: pathStack.join('/') });
            }
        }
    }

    // --- Cache Ref Update Logic (Advanced) ---
    async function updateCacheRefs(doc) {
        if (!doc.fileName.endsWith('.js') || !doc.fileName.includes(path.sep + 'products' + path.sep)) return;
        try {
            const rootPath = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0 ? vscode.workspace.workspaceFolders[0].uri.fsPath : '';
            if (!rootPath) return;
            const slug = path.basename(path.dirname(doc.fileName));
            if (slug !== path.basename(doc.fileName, '.js')) return;

            const cachePath = path.join(rootPath, 'db/translations/translations.ai.cache.json');
            if (!fs.existsSync(cachePath)) return;

            // Read & Cleanup Cache
            let cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            let cacheModified = false;
            const refPrefix = `product://${slug}@`;
            Object.keys(cache).forEach(k => {
                if (cache[k].refs) {
                    const originalLength = cache[k].refs.length;
                    cache[k].refs = cache[k].refs.filter(r => !r.startsWith(refPrefix));
                    if (cache[k].refs.length !== originalLength) cacheModified = true;
                }
            });

            // Parse File
            const content = doc.getText();
            const tokens = tokenize(content);
            const ast = parse(tokens);
            const results = [];
            traverseAndCollect(ast, [], results, false);

            results.forEach(res => {
                let cacheKey = res.key;
                let htmlPath = null;
                if (res.isLoad) {
                     const htmlPathAbs = path.join(path.dirname(doc.fileName), res.htmlPath.trim());
                     if (fs.existsSync(htmlPathAbs)) {
                         cacheKey = fs.readFileSync(htmlPathAbs, 'utf8');
                         htmlPath = res.htmlPath.trim();
                     } else cacheKey = null;
                }
                
                if (cacheKey && cache[cacheKey]) {
                    const suffix = htmlPath ? `#${htmlPath}` : '';
                    const newRef = `product://${slug}@${res.line}:${res.col}/${res.path}${suffix}`;
                    if (!cache[cacheKey].refs) cache[cacheKey].refs = [];
                    if (!cache[cacheKey].refs.includes(newRef)) {
                        cache[cacheKey].refs.push(newRef);
                        cache[cacheKey].refs.sort();
                        cacheModified = true;
                    }
                }
            });

            if (cacheModified) {
               fs.writeFileSync(cachePath, JSON.stringify(cache, null, 4));
            }
        } catch (e) {
            console.error('Error updating cache refs:', e);
        }
    }

    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.fileName.endsWith('.js') && doc.fileName.includes('products')) {
            updateStatusBar();
            updateCacheRefs(doc);
        }
    }));

    // Watch for HTML saves to invalidate JS load() and update cache
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
        // Only react to HTML files inside 'db/products' (implied by checking for product JS context)
        if (doc.languageId === 'html') {
            try {
                const newText = doc.getText();
                // If empty we still might want to track it? But usually we only translate non-empty. 
                // User requirement: "If empty string... use empty string". 
                if (!newText.trim()) return;

                const rootPath = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
                ? vscode.workspace.workspaceFolders[0].uri.fsPath
                : '';
                
                if (!rootPath) return;

                // Find Context (Product/SKU)
                let jsFile = null;
                let sku = null;
                let productDirPath = null;

                let dir = path.dirname(doc.fileName);
                for (let i = 0; i < 4; i++) { // Walk up max 4 levels
                    const files = fs.readdirSync(dir);
                    const parentName = path.basename(dir);
                    
                    // Specific check for Product structure: products/[SKU]/[SKU].js
                    if (path.basename(path.dirname(dir)) === 'products') {
                         const candidate = files.find(f => (f.startsWith(parentName + '.') || f === parentName + '.js') && f.endsWith('.js') && !f.endsWith('thumbs.js'));
                         if (candidate) {
                             jsFile = path.join(dir, candidate);
                             sku = parentName;
                             productDirPath = dir;
                             break;
                         }
                    }
                    // Keep looking up
                    const parent = path.dirname(dir);
                    if (parent === dir) break;
                    dir = parent;
                }

                if (!jsFile) return; // Not a product HTML file we recognize

                const cachePath = path.join(rootPath, 'db/translations/translations.ai.cache.json');
                const orphanPath = path.join(rootPath, 'db/translations/translations.orphans.json');
                
                let cache = {};
                if (fs.existsSync(cachePath)) {
                    cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
                }
                
                let orphans = {};
                if (fs.existsSync(orphanPath)) {
                    orphans = JSON.parse(fs.readFileSync(orphanPath, 'utf8'));
                }

                const text = newText;
                const textDone = text + ' ';
                
                let isAlreadyTranslated = false;
                let cacheModified = false;
                let orphansModified = false;
                
                // Ref Generation
                let newRef = null;
                if (jsFile) {
                    // Ref calculation
                    const jsContent = fs.readFileSync(jsFile, 'utf8');
                    const relativeHtmlPath = path.relative(productDirPath, doc.fileName).replace(/\\/g, '/');
                    const escapedPath = relativeHtmlPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    
                    const lines = jsContent.split(/\r?\n/);
                    // Match load('path') with optional trailing space inside quotes
                    const lineIdx = lines.findIndex(l => l.match(new RegExp(`load\\s*\\(\\s*['"]${escapedPath}\\s*['"]\\s*\\)`)));
                    
                    if (lineIdx !== -1) {
                        const match = lines[lineIdx].match(new RegExp(`load\\s*\\(\\s*['"]${escapedPath}\\s*['"]\\s*\\)`));
                        let col = 1;
                        if (match) {
                             col = match.index + 1;
                        }

                        let jsonPath = relativeHtmlPath.replace(/\.html$/, '');
                        newRef = `product://${sku}@${lineIdx + 1}:${col}/${jsonPath}#${relativeHtmlPath}`;
                    }
                }

                // Helper to create sorted object
                const createTranslationObject = (enText) => {
                    const sortedLangs = ["en", "ro", "fr", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi", "hr", "hu", "is", "it", "ja", "lt", "lv", "nl", "no", "pl", "pt", "sk", "sl", "sv", "zh"];
                    const obj = { refs: [] };
                    sortedLangs.forEach(lang => {
                        obj[lang] = (lang === 'en') ? enText : enText.trim();
                    });
                    // Only add ref if available
                    if (newRef) {
                        obj.refs.push(newRef);
                    }
                    return obj;
                };

                const updateCacheEntry = (key, existingEntry = null) => {
                     let entry = existingEntry;
                     if (!entry || typeof entry === 'string') { // string (old format or " ")
                         entry = createTranslationObject(key.trim()); // recreate structure
                     }
                     
                     // Use newRef
                     if (newRef) {
                         if (!entry.refs) entry.refs = [];
                         // Remove old ref with same SKU/Line context to avoid dupes/versions?
                         // It's hard to know exactly which old ref maps to this without strict parsing.
                         // But we can filter out refs that match our newRef exactly.
                         if (!entry.refs.includes(newRef)) {
                              entry.refs.push(newRef);
                              
                              // Optional: Clean up "old style" refs for this file if we can identify them?
                              // e.g. tools/.../SKU.js:Line. 
                              // Use the line we found?
                              // This is maybe too aggressive if multiple things are on same line (unlikely for load).
                         }
                         
                         // Sort refs to be nice?
                         entry.refs.sort();
                     }
                     return entry;
                };

                if (cache[textDone]) {
                    cache[textDone] = updateCacheEntry(textDone, cache[textDone]);
                    isAlreadyTranslated = true;
                    cacheModified = true;
                } else if (cache[text]) {
                    cache[text] = updateCacheEntry(text, cache[text]);
                    isAlreadyTranslated = false; 
                    cacheModified = true;
                } else {
                     if (orphans[textDone]) {
                         cache[textDone] = updateCacheEntry(textDone, orphans[textDone]); // Move orphan
                         // If orphan was string, updateCacheEntry handles it converting to object
                         // But if orphan was already object, we append ref.
                         delete orphans[textDone];
                         isAlreadyTranslated = true; 
                         cacheModified = true;
                         orphansModified = true;
                     } else if (orphans[text]) {
                          cache[text] = updateCacheEntry(text, orphans[text]);
                          delete orphans[text];
                          isAlreadyTranslated = false;
                          cacheModified = true;
                          orphansModified = true;
                     } else {
                         // New Entry
                         cache[text] = createTranslationObject(text); // updateCacheEntry logic inline effectively
                         isAlreadyTranslated = false;
                         cacheModified = true;
                     }
                }
                
                if (orphansModified) fs.writeFileSync(orphanPath, JSON.stringify(orphans, null, 4));
                if (cacheModified) fs.writeFileSync(cachePath, JSON.stringify(cache, null, 4));

                if (!isAlreadyTranslated) {
                    if (jsFile) {
                        const jsPath = jsFile;
                        let jsContent = fs.readFileSync(jsPath, 'utf8');
                        const relativeHtmlPath = path.relative(productDirPath, doc.fileName).replace(/\\/g, '/');
                        const escRel = relativeHtmlPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        
                        // Invalidate the load call (remove trailing space inside quotes if present)
                        const regex = new RegExp(`(load\\s*\\(\\s*['"])(${escRel})(\\s+)(['"]\\s*\\))`, 'g');
                        if (regex.test(jsContent)) {
                            jsContent = jsContent.replace(regex, '$1$2$4');
                            fs.writeFileSync(jsPath, jsContent, 'utf8');
                            
                            // Re-calculate ref? Line might change if file changed length (unlikely for simple replace)
                            // But we already calculated ref based on file on disk. 
                            // If we save JS now, next save of HTML will pick it up. 
                            // Or this invalidate triggers JS watcher?
                        }
                    }
                }
            } catch (e) {
                console.error('Error in HTML save handler:', e);
            }
        }
    }));

    // Watch for translation cache changes
    const cacheWatcher = vscode.workspace.createFileSystemWatcher('**/db/translations/translations.ai.cache.json');
    cacheWatcher.onDidChange(updateStatusBar);
    cacheWatcher.onDidCreate(updateStatusBar);
    cacheWatcher.onDidDelete(updateStatusBar);
    context.subscriptions.push(cacheWatcher);
    
    // Initial update
    updateStatusBar();
    
    // --- End Translation Status Bar Logic ---

    // --- DocumentLinkProvider (Enhanced for Thumbs & CSS) ---
    const provider = {
        async provideDocumentLinks(document, token) {
            const text = document.getText();
            const links = [];
            const docUri = document.uri;
            const docDir = path.dirname(docUri.fsPath);
            const wFolders = vscode.workspace.workspaceFolders;

            // Helper: Async check for file existence via diverse strategies (With Dist Fallback)
            const resolvePath = async (linkText) => {
                 const cleanLink = linkText.replace(/^\.\//, '').replace(/^\//, '');
                 
                 // Strategy A: Direct Resolution
                 let candidates = [];
                 
                 // 1. Relative
                 candidates.push(path.join(docDir, linkText));
                 
                 // 2. Workspace Roots
                 if (wFolders) {
                     for (const folder of wFolders) {
                         candidates.push(path.join(folder.uri.fsPath, linkText));
                         candidates.push(path.join(folder.uri.fsPath, cleanLink));
                     }
                 }

                 // 3. Walk-Up / Heuristic
                 if (linkText.includes('thumbs') || linkText.includes('css')) {
                     let currentScanDir = docDir;
                     let searchPart = cleanLink;
                     if (cleanLink.includes('thumbs/')) searchPart = cleanLink.substring(cleanLink.indexOf('thumbs/'));
                     for(let i=0; i<8; i++) {
                         candidates.push(path.join(currentScanDir, searchPart));
                         const nextDir = path.dirname(currentScanDir);
                         if (nextDir === currentScanDir) break; 
                         currentScanDir = nextDir;
                     }
                 }

                 // Evaluate Candidates
                 for (const cand of candidates) {
                     if (fs.existsSync(cand)) {
                         // Check if 0 bytes (empty) and try to find a better one in 'dist'
                         try {
                            const stats = fs.statSync(cand);
                            if (stats.size === 0) {
                                // Normalize for checking
                                const normalized = cand.replace(/\\/g, '/');
                                
                                // Case 1: src -> dist
                                if (normalized.includes('/src/')) {
                                    const distCand = cand.replace(/[\\\/]src[\\\/]/, path.sep + 'dist' + path.sep);
                                    if (fs.existsSync(distCand) && fs.statSync(distCand).size > 0) return distCand;
                                }

                                // Case 2: Special cache structure (website/src -> website/dist/cache/...)
                                if (normalized.includes('website/src')) {
                                     // Attempt to split and inject cache path
                                     const parts = normalized.split('website/src');
                                     if (parts.length >= 2) {
                                         // Reconstruct using system separators
                                         const prefix = parts[0].split('/').join(path.sep);
                                         const suffix = parts[1].split('/').join(path.sep);
                                         const cachePath = path.join(prefix, 'website', 'dist', 'cache', 'css', 'website', 'src', suffix);
                                         
                                         if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) return cachePath;
                                     }
                                }
                            }
                            return cand;
                         } catch (e) { return cand; }
                     }
                 }
                 
                 // 4. Global Search (Last Resort)
                 try {
                    const foundFiles = await vscode.workspace.findFiles('**/' + cleanLink, '**/node_modules/**', 1);
                    if (foundFiles.length > 0) return foundFiles[0].fsPath;
                    const filename = path.basename(cleanLink);
                    const foundFiles2 = await vscode.workspace.findFiles('**/' + filename, '**/node_modules/**', 1);
                    if (foundFiles2.length > 0) return foundFiles2[0].fsPath;
                 } catch (e) {}

                 return null;
            };

            const existingLinks = []; 
            // helper to push link (Safe for String path or Uri object)
            const addLink = (start, end, target, tooltip) => {
                 // Check for overlap
                 for (const existing of existingLinks) {
                     // If new range is completely within or identical to existing, skip
                     if (start >= existing.start && end <= existing.end) return;
                     // If new range fully covers existing, we might technically duplicate but usually we parse smaller tokens first? 
                     // Actually let's just checking for substantial overlap or identity.
                     if (start === existing.start && end === existing.end) return;
                 }
                 
                 existingLinks.push({ start, end });

                 const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
                 let targetUri = target;
                 if (typeof target === 'string') {
                     targetUri = vscode.Uri.file(target);
                 }
                 const link = new vscode.DocumentLink(range, targetUri);
                 link.tooltip = tooltip || `Open ${path.basename(targetUri.fsPath)}`;
                 links.push(link);
            };




            // 1. Variable substitution links: file://${VAR}/...
            const varRegex = /(file:\/\/\$\{([^}]+)\}([^"'\s]*))/g;
            let match;
            while ((match = varRegex.exec(text))) {
                const fullMatch = match[1]; 
                const varName = match[2];   
                const remainder = match[3]; 

                const config = vscode.workspace.getConfiguration();
                const varValue = config.get(varName);

                if (varValue && typeof varValue === 'string') {
                    let filePathPart = remainder;
                    let line = 0;
                    
                    const lineMatch = /:(\d+)/.exec(remainder);
                    if (lineMatch) {
                        line = parseInt(lineMatch[1]);
                        const idx = remainder.lastIndexOf(':' + lineMatch[1]);
                        if (idx !== -1) filePathPart = remainder.substring(0, idx);
                    } else {
                        const hashIdx = remainder.indexOf('#');
                        if (hashIdx !== -1) filePathPart = remainder.substring(0, hashIdx);
                    }

                    let combined = path.join(varValue, filePathPart);
                    combined = combined.replace(/\\/g, '/');
                    
                    if (!combined.startsWith('/')) {
                        combined = '/' + combined;
                    }

                    let targetUri = vscode.Uri.file(combined);
                    if (line > 0) {
                        targetUri = targetUri.with({ fragment: `L${line}` });
                    }

                    // Use addLink with URI
                    addLink(match.index, match.index + fullMatch.length, targetUri, `Open ${combined}`);
                }
            }

            // 2. Custom DATEx2 Links: product://... profile@...
            const customRegex = /([\"'])(?:(product):([^@]+)@|(profile|category)@)([^\/]+)\/([^#\"']+?)(?:#([^\"']+))?\1/g;
            while ((match = customRegex.exec(text))) {
                const fullMatchStr = match[0];
                let type, hostPart, posPart, jsonPath, htmlPath;
                
                if (match[2] === 'product') {
                    type = 'product';
                    hostPart = match[3];
                    posPart = match[5];
                    jsonPath = match[6];
                    htmlPath = match[7];
                } else {
                    type = match[4];
                    hostPart = '';
                    posPart = match[5];
                    jsonPath = match[6];
                    htmlPath = match[7];
                }

                let targetPath = '';
                let targetLine = 1;
                let targetCol = 1;
                
                const posParts = posPart.split(':');
                if (posParts.length > 0) targetLine = parseInt(posParts[0]);
                if (posParts.length > 1) targetCol = parseInt(posParts[1]);

                if (type === 'profile') {
                    targetPath = 'db/profile/profile.js';
                    if (htmlPath) {
                         targetPath = `db/profile/${htmlPath}`;
                         targetLine = 1; targetCol = 1;
                    }
                } else if (type === 'category') {
                    targetPath = 'db/categories/categories.js';
                    if (htmlPath) {
                        targetPath = `db/categories/${htmlPath}`;
                        targetLine = 1; targetCol = 1;
                    }
                } else if (type === 'product') {
                    const codeOrSlug = hostPart;
                    if (codeOrSlug) {
                        const rootPath = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : '';
                        
                        if (htmlPath) {
                             // Look up JS file to get folder
                             const jsPath = global.datex2ProductMap && global.datex2ProductMap[codeOrSlug];
                             if (jsPath && rootPath) {
                                 const folder = path.dirname(jsPath);
                                 // Construct absolute then relative
                                 const absHtml = path.join(folder, htmlPath);
                                 if (fs.existsSync(absHtml)) {
                                     targetPath = path.relative(rootPath, absHtml);
                                     targetLine = 1; targetCol = 1;
                                 }
                             }
                        } else {
                            // Link to Product JS
                            const jsPath = global.datex2ProductMap && global.datex2ProductMap[codeOrSlug];
                            if (jsPath && rootPath) {
                                targetPath = path.relative(rootPath, jsPath);
                            }
                        }
                    }
                }

                if (targetPath) {
                     const rootPath = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : '';
                     if (rootPath) {
                     const absPath = path.join(rootPath, targetPath);
                         
                         // Smart Navigation: Use command to find property in file dynamically
                         // match[6] is the property key (e.g. 'seoDescription')
                         if (jsonPath && jsonPath.trim().length > 0) {
                             const args = encodeURIComponent(JSON.stringify({
                                 filePath: absPath,
                                 line: targetLine,
                                 col: targetCol,
                                 prop: jsonPath
                             }));
                             const commandUri = vscode.Uri.parse(`command:datex2.smartGoTo?${args}`);
                             
                             const matchIndex = match.index; 
                             const startChar = matchIndex + 1; 
                             const endChar = matchIndex + fullMatchStr.length - 1;
                             
                             // Manual link creation to support command URI
                             const range = new vscode.Range(document.positionAt(startChar), document.positionAt(endChar));
                             const link = new vscode.DocumentLink(range, commandUri);
                             link.tooltip = `Go to '${jsonPath}' in ${path.basename(targetPath)}`;
                             links.push(link);
                             
                         } else {
                             // Fallback to static line number
                             let targetUri = vscode.Uri.file(absPath);
                             if (targetLine > 0) {
                                targetUri = targetUri.with({ fragment: `L${targetLine}${targetCol > 1 ? ','+targetCol : ''}` });
                             }
                             
                             const matchIndex = match.index; 
                             const startChar = matchIndex + 1; 
                             const endChar = matchIndex + fullMatchStr.length - 1;
                             
                             addLink(startChar, endChar, targetUri, `Open ${targetPath} at line ${targetLine}:${targetCol}`);
                         }
                     }
                }
            }

            // 3. Data URIs
            const dataUriRegex = /(["'])(data:[^"'\s]*)\1|url\((data:[^)"'\s]*)\)/g;
            while ((match = dataUriRegex.exec(text))) {
                 const isUnquoted = !!match[3];
                 const fullUri = isUnquoted ? match[3] : match[2];
                 
                 let start, end;
                 if (isUnquoted) {
                     start = match.index + 4; 
                     end = start + fullUri.length;
                 } else {
                     start = match.index + 1; 
                     end = start + fullUri.length;
                 }

                 const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
                 const args = [fullUri];
                 const commandUri = vscode.Uri.parse(`command:datex2.openDataUri?${encodeURIComponent(JSON.stringify(args))}`);
                 
                 // Manual link push to avoid addLink duplicate check (ranges differ slightly sometimes or we want specific tooltip control)
                 // Actually better to use addLink if possible, but data URIs are distinct.
                 const link = new vscode.DocumentLink(range, commandUri);
                 link.tooltip = "Open Data URI in Browser";
                 links.push(link);
            }

            // Helper to get file size string
            const getFileSize = (filePath) => {
                try {
                    const stats = fs.statSync(filePath);
                    const sizeKB = (stats.size / 1024).toFixed(2);
                    let info = `(${sizeKB} KB)`;
                    
                    // Check for .gz version
                    const gzPath = filePath + '.gz';
                    if (fs.existsSync(gzPath)) {
                        const gzStats = fs.statSync(gzPath);
                        const gzSizeKB = (gzStats.size / 1024).toFixed(2);
                        info += ` | Gzip: (${gzSizeKB} KB)`;
                    }
                    return info;
                } catch (e) {
                    return '';
                }
            };

            // 4. CSS Arrays in JS (css: ["file.css"])
            const cssRegex = /(?:css|css360)\s*:\s*(\[[^\]]*\]|"[^"]*"|'[^']*')/g;
            while ((match = cssRegex.exec(text))) {
                 const arrayOrString = match[1];
                 const arrayStart = match.index + match[0].indexOf(arrayOrString);
                 
                 // Extract strings inside
                 const strRegex = /(['"])(.*?)\1/g;
                 let strMatch;
                 while ((strMatch = strRegex.exec(arrayOrString))) {
                      const linkText = strMatch[2];
                      if (!linkText.endsWith('.css') && !linkText.endsWith('.gz')) continue;

                      // Exact position
                      const localStart = strMatch.index + 1; // plus quote
                      const absStart = arrayStart + localStart;
                      const absEnd = absStart + linkText.length;
                      
                      const resolved = await resolvePath(linkText);
                      if (resolved) {
                           addLink(absStart, absEnd, vscode.Uri.file(resolved), `Reveal CSS File`);
                      }
                 }
            }


            // 5. Thumbs Paths (/thumbs/...)
            // Matches: "/thumbs/filename.ext" or "./thumbs/filename.ext" or "thumbs/filename.ext"
            const thumbsRegex = /["'](\.|\/)?\/?(thumbs\/[^"']+\.(webp|png|jpg|jpeg|css|gz))["']/g;
            while ((match = thumbsRegex.exec(text))) {
                  const fullMatch = match[0];
                  const innerPath = match[2]; // thumbs/...
                  
                  // Calculate positions inside quotes
                  const quoteStart = match.index; 
                  // Find start of relevant path part inside the match
                  const pathStartInMatch = fullMatch.indexOf(innerPath);
                  const start = quoteStart + pathStartInMatch;
                  const end = start + innerPath.length;

                  // Thumbs also use resolvePath strategy now for consistency!
                //   const resolved = await resolvePath(innerPath);
                //   if (resolved) {
                //        const sizeStr = getFileSize(resolved);
                //        addLink(start, end, vscode.Uri.file(resolved), `Reveal File ${sizeStr}`);
                //   }
            }

            // 6. Relative Workspace Paths (Generic)
            // Matches strings starting with specific prefixes often used in this project
            // e.g. "db/products/..." inside quotes
            const relPathRegex = /["']((?:db|website|tools)\/[^"']+\.[a-zA-Z0-9]+)["']/g;
            while ((match = relPathRegex.exec(text))) {
                  const fullMatch = match[0];
                  const innerPath = match[1];
                  const quoteStart = match.index; 
                  const start = quoteStart + 1; 
                  const end = start + innerPath.length;

                  // Use resolvePath
                  const resolved = await resolvePath(innerPath);
                  if (resolved) {
                       addLink(start, end, vscode.Uri.file(resolved), `Reveal File`);
                  }
            }




            return links;
        }
    };

    // --- Helper to save Data URI to temp file ---
    function saveDataUriToTemp(dataUri) {
        try {
            const matches = dataUri.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                let ext = matches[1];
                if (ext.includes('svg')) ext = 'svg'; 
                const base64Data = matches[2];
                
                const tmpDir = path.join(os.tmpdir(), 'datex2-smart-hover');
                if (!fs.existsSync(tmpDir)) {
                    fs.mkdirSync(tmpDir, { recursive: true });
                }
                
                const hash = crypto.createHash('md5').update(base64Data).digest('hex');
                const tmpFile = path.join(tmpDir, `img_${hash}.${ext}`);
                
                // Only write if not exists (caching)
                if (!fs.existsSync(tmpFile)) {
                    const buffer = Buffer.from(base64Data, 'base64');
                    fs.writeFileSync(tmpFile, buffer);
                }
                
                return tmpFile;
            }
        } catch (e) {
             console.error('Failed to process data URI:', e);
        }
        return null;
    }

    // Command to open external file
    context.subscriptions.push(vscode.commands.registerCommand('datex2.openExternalFile', (filePath) => {
        try {
            if (process.platform === 'win32') {
                cp.exec(`start "" "${filePath}"`);
            } else if (process.platform === 'darwin') {
                cp.exec(`open "${filePath}"`);
            } else {
                cp.exec(`xdg-open "${filePath}"`);
            }
        } catch (e) {
            vscode.window.showErrorMessage('Failed to open file: ' + e.message);
        }
    }));

    // Command to Open Data URI
    context.subscriptions.push(vscode.commands.registerCommand('datex2.openDataUri', (dataUri) => {
        const filePath = saveDataUriToTemp(dataUri);
        if (filePath) {
             vscode.commands.executeCommand('datex2.openExternalFile', filePath);
        } else {
             vscode.window.showErrorMessage('Failed to open Data URI image.');
        }
    }));

    // Command to open file at specific location
    context.subscriptions.push(vscode.commands.registerCommand('datex2.openFileAtLocation', async (filePath, line, col) => {
        if (!filePath) return;
        try {
            let targetUri;
            if (typeof filePath === 'string') {
                targetUri = vscode.Uri.file(filePath);
            } else if (filePath instanceof vscode.Uri) {
                targetUri = filePath;
            } else {
                 if (filePath.scheme) {
                     targetUri = vscode.Uri.from(filePath);
                 } else {
                     targetUri = vscode.Uri.file(String(filePath));
                 }
            }

            const doc = await vscode.workspace.openTextDocument(targetUri);
            const editor = await vscode.window.showTextDocument(doc);
            if (typeof line === 'number' && line > 0) {
                const pos = new vscode.Position(line - 1, (col && col > 0) ? col - 1 : 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            }
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to open file: ${e.message}`);
        }
    }));

    // --- Smart GoTo Command (Finds Property) ---
    context.subscriptions.push(vscode.commands.registerCommand('datex2.smartGoTo', async (args) => {
        try {
            // Args usually come as object if parsed from JSON in URI
            const { filePath, line, col, prop } = args;
            if (!filePath) return;

            const doc = await vscode.workspace.openTextDocument(filePath);
            const editor = await vscode.window.showTextDocument(doc);
            const text = doc.getText();

            let targetPos = new vscode.Position(line > 0 ? line - 1 : 0, 0);

            // 1. Try to find Property in text
            if (prop) {
                // Regex: property key followed by colon.
                // Tolerates quotes:  "prop":  or  prop:  or  'prop':
                const regex = new RegExp(`(?:["']?)\\b${prop}\\b(?:["']?)\\s*:`);
                const match = regex.exec(text);
                
                if (match) {
                    targetPos = doc.positionAt(match.index);
                } else {
                    // Fallback: Try finding it in 'exports' or specific patterns if standard KV fails?
                    // For now, if not found, we fallback to the provided line number (which might be wrong, but better than nothing)
                }
            }

            editor.selection = new vscode.Selection(targetPos, targetPos);
            editor.revealRange(new vscode.Range(targetPos, targetPos), vscode.TextEditorRevealType.InCenter);

        } catch (e) {
            vscode.window.showErrorMessage(`Smart Nav Failed: ${e.message}`);
        }
    }));

    // --- Definition Provider (F12 Support) ---
    const definitionProvider = {
        async provideDefinition(document, position, token) {
             const line = document.lineAt(position.line);
             const text = line.text;
             const docUri = document.uri;
             const docDir = path.dirname(docUri.fsPath);
             const wFolders = vscode.workspace.workspaceFolders;

             // Helper for resolution (duplicated to be self-contained)
             const resolvePath = async (linkText) => {
                 const cleanLink = linkText.replace(/^\.\//, '').replace(/^\//, '');
                 
                 // 1. Relative
                 const relativePath = path.join(docDir, linkText);
                 if (fs.existsSync(relativePath)) return relativePath;

                 // 2. Workspace Roots
                 if (wFolders) {
                     for (const folder of wFolders) {
                         const rootPath = path.join(folder.uri.fsPath, linkText);
                         if (fs.existsSync(rootPath)) return rootPath;
                         const rootClean = path.join(folder.uri.fsPath, cleanLink);
                         if (fs.existsSync(rootClean)) return rootClean;
                     }
                 }

                 // 3. Walk-Up Heuristic
                 if (linkText.includes('thumbs') || linkText.includes('css')) {
                     let currentScanDir = docDir;
                     let searchPart = cleanLink;
                     if (cleanLink.includes('thumbs/')) searchPart = cleanLink.substring(cleanLink.indexOf('thumbs/'));

                     for(let i=0; i<8; i++) {
                         const candidate = path.join(currentScanDir, searchPart); 
                         if (fs.existsSync(candidate)) return candidate;
                         const nextDir = path.dirname(currentScanDir);
                         if (nextDir === currentScanDir) break; 
                         currentScanDir = nextDir;
                     }
                 }

                 // 4. Global Search
                 try {
                    const filename = path.basename(cleanLink);
                    const foundFiles = await vscode.workspace.findFiles('**/' + cleanLink, '**/node_modules/**', 1);
                    if (foundFiles.length > 0) return foundFiles[0].fsPath;
                    const foundFiles2 = await vscode.workspace.findFiles('**/' + filename, '**/node_modules/**', 1);
                    if (foundFiles2.length > 0) return foundFiles2[0].fsPath;
                 } catch (e) {}

                 return null;
             };

             // Check for CSS Arrays: css: ["..."]
             // We check if cursor is inside a string that looks like a file path
             const range = document.getWordRangeAtPosition(position, /["']([^"']+)["']/);
             if (range) {
                 const fullMatch = document.getText(range);
                 const inner = fullMatch.substring(1, fullMatch.length - 1);
                 
                 // If it ends with .css or has slash, try to resolve
                 if (inner.endsWith('.css') || inner.includes('/')) {
                     const valid = await resolvePath(inner);
                     if (valid) {
                         return new vscode.Location(vscode.Uri.file(valid), new vscode.Position(0, 0));
                     }
                 }
             }
             
             return null;
        }
    };
    context.subscriptions.push(vscode.languages.registerDefinitionProvider(['json', 'javascript', 'html', 'css', 'scss', 'less'], definitionProvider));


    context.subscriptions.push(vscode.languages.registerHoverProvider(['json', 'javascript', 'html', 'css', 'scss', 'less'], {
        async provideHover(document, position, token) {
            const line = document.lineAt(position.line);
            const text = line.text;
            const docUri = document.uri;
            const docDir = path.dirname(docUri.fsPath);
            const wFolders = vscode.workspace.workspaceFolders;

            // Helper: Resolve Path
             const resolvePath = async (linkText) => {
                 const cleanLink = linkText.replace(/^\.\//, '').replace(/^\//, '');
                 
                 // Strategy A: Direct Resolution
                 let candidates = [];
                 
                 // 1. Relative
                 candidates.push(path.join(docDir, linkText));
                 
                 // 2. Workspace Roots
                 if (wFolders) {
                     for (const folder of wFolders) {
                         candidates.push(path.join(folder.uri.fsPath, linkText));
                         candidates.push(path.join(folder.uri.fsPath, cleanLink));
                     }
                 }

                 // 3. Walk-Up / Heuristic
                 if (linkText.includes('thumbs') || linkText.includes('css')) {
                     let currentScanDir = docDir;
                     let searchPart = cleanLink;
                     if (cleanLink.includes('thumbs/')) searchPart = cleanLink.substring(cleanLink.indexOf('thumbs/'));
                     for(let i=0; i<8; i++) {
                         candidates.push(path.join(currentScanDir, searchPart));
                         const nextDir = path.dirname(currentScanDir);
                         if (nextDir === currentScanDir) break; 
                         currentScanDir = nextDir;
                     }
                 }

                 // Evaluate Candidates
                 for (const cand of candidates) {
                     if (fs.existsSync(cand)) {
                         // Check if 0 bytes (empty) and try to find a better one in 'dist'
                         try {
                            const stats = fs.statSync(cand);
                            if (stats.size === 0) {
                                // Normalize for checking
                                const normalized = cand.replace(/\\/g, '/');
                                
                                // Case 1: src -> dist
                                if (normalized.includes('/src/')) {
                                    const distCand = cand.replace(/[\\\/]src[\\\/]/, path.sep + 'dist' + path.sep);
                                    if (fs.existsSync(distCand) && fs.statSync(distCand).size > 0) return distCand;
                                }

                                // Case 2: Special cache structure (website/src -> website/dist/cache/...)
                                if (normalized.includes('website/src')) {
                                     const parts = normalized.split('website/src');
                                     if (parts.length >= 2) {
                                         const prefix = parts[0].split('/').join(path.sep);
                                         const suffix = parts[1].split('/').join(path.sep);
                                         const cachePath = path.join(prefix, 'website', 'dist', 'cache', 'css', 'website', 'src', suffix);
                                         if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) return cachePath;
                                     }
                                }
                            }
                            return cand;
                         } catch (e) { return cand; }
                     }
                 }

                 try {
                    const filename = path.basename(cleanLink);
                    const foundFiles = await vscode.workspace.findFiles('**/' + cleanLink, '**/node_modules/**', 1);
                    if (foundFiles.length > 0) return foundFiles[0].fsPath;
                    const foundFiles2 = await vscode.workspace.findFiles('**/' + filename, '**/node_modules/**', 1);
                    if (foundFiles2.length > 0) return foundFiles2[0].fsPath;
                 } catch (e) {}
                 return null;
             };

             // Helper: Get File Size (Markdown)
             const getFileSizeMarkdown = (filePath) => {
                try {
                    const stats = fs.statSync(filePath);
                    const sizeKB = stats.size / 1024;
                    
                    // Format size: MB if > 1024KB, otherwise KB
                    let info = '';
                    if (sizeKB > 1024) {
                        const sizeMB = (sizeKB / 1024).toFixed(2);
                        info = `${sizeMB}MB`;
                    } else {
                        info = `${sizeKB.toFixed(2)}KB`;
                    }
                    
                    // Logic to find smallest compressed version
                    // 1. Determine base search path (if src, try dist too)
                    let searchPaths = [path.dirname(filePath)];
                    const normalized = filePath.replace(/\\/g, '/');
                    if (normalized.includes('/src/')) {
                        const distDir = filePath.replace(/[\\\/]src[\\\/]/, path.sep + 'dist' + path.sep)
                                                .substring(0, filePath.lastIndexOf(path.sep)); // this logic is slightly flawed for dirname, let's just use path replacement
                        const distDir2 = path.dirname(filePath.replace(/[\\\/]src[\\\/]/, path.sep + 'dist' + path.sep));
                        if (fs.existsSync(distDir2)) searchPaths.push(distDir2);
                        
                        // Check for cache path logic website/src -> website/dist/cache...
                        if (normalized.includes('website/src')) {
                             const parts = normalized.split('website/src');
                             if (parts.length >= 2) {
                                 const prefix = parts[0].split('/').join(path.sep);
                                 const suffix = path.dirname(parts[1]).split('/').join(path.sep);
                                 const cachePath = path.join(prefix, 'website', 'dist', 'cache', 'css', 'website', 'src', suffix);
                                 if (fs.existsSync(cachePath)) searchPaths.push(cachePath);
                             }
                        }
                    }

                    const baseName = path.basename(filePath);
                    // Candidates to check in all searchPaths
                    // Prefer minified versions for compression check
                    let namesToCheck = [baseName];
                    if (baseName.endsWith('.css') && !baseName.includes('.min.css')) {
                        namesToCheck.push(baseName.replace('.css', '.min.css'));
                    }

                    const extensions = [
                        { ext: '.br', label: 'BR' },
                        { ext: '.gz', label: 'GZIP' },
                        { ext: '.zstd', label: 'ZSTD' }
                    ];

                    let bestCompressed = null;

                    for (const dir of searchPaths) {
                        for (const name of namesToCheck) {
                            for (const alg of extensions) {
                                const checkPath = path.join(dir, name + alg.ext);
                                if (fs.existsSync(checkPath)) {
                                    try {
                                        const cStats = fs.statSync(checkPath);
                                        if (cStats.size > 0) {
                                            if (!bestCompressed || cStats.size < bestCompressed.size) {
                                                bestCompressed = {
                                                    path: checkPath,
                                                    size: cStats.size,
                                                    label: alg.label
                                                };
                                            }
                                        }
                                    } catch (e) {}
                                }
                            }
                        }
                    }

                    if (bestCompressed) {
                        const cSizeKB = bestCompressed.size / 1024;
                        let cSizeStr = '';
                        if (cSizeKB > 1024) {
                            cSizeStr = `${(cSizeKB / 1024).toFixed(2)}MB`;
                        } else {
                            cSizeStr = `${cSizeKB.toFixed(2)}KB`;
                        }
                        
                        const saving = ((bestCompressed.size - stats.size) / stats.size * 100).toFixed(0);
                        // Add percentage if there is a reduction
                        const percentStr = saving < 0 ? ` <span style="color:#FFD700;">${saving}%</span>` : '';
                        info += ` (${bestCompressed.label} **${cSizeStr}**${percentStr})`;
                    }

                    return info;
                } catch (e) {
                    return '';
                }
            };
            
            // 1. Data URIs
            const dataUriRegex = /(["'])(data:image\/[^"'\s]*)\1|url\((data:image\/[^)"'\s]*)\)/g;
            let match;
            while ((match = dataUriRegex.exec(text))) {
                const isUnquoted = !!match[3];
                const dataUri = isUnquoted ? match[3] : match[2];
                let startOfData, endOfData;
                if (isUnquoted) { startOfData = match.index + 4; endOfData = startOfData + dataUri.length; } 
                else { startOfData = match.index + 1; endOfData = startOfData + dataUri.length; }

                if (position.character >= startOfData && position.character <= endOfData) {
                    const config = vscode.workspace.getConfiguration('datex2.hover.dataUri');
                    if (!config.get('enabled')) return null;

                    const maxWidth = config.get('maxWidth') || 300;
                    const showFileSize = config.get('showFileSize');

                    let sizeInfo = '';
                    const sizeInBytes = Math.round((dataUri.length - 22) * 3 / 4); 
                    if (showFileSize) {
                        const sizeKB = (sizeInBytes / 1024).toFixed(2);
                        sizeInfo = ` (${sizeKB} KB)`;
                    }

                    // Large Data URI Handling
                    let imageSrc = dataUri;
                    const filePathForOpen = saveDataUriToTemp(dataUri);
                    if (filePathForOpen && dataUri.length > 50000) {
                        imageSrc = vscode.Uri.file(filePathForOpen).toString();
                    }
                    
                    const md = new vscode.MarkdownString();
                    md.supportHtml = true; md.isTrusted = true;
                    
                    let imageHtml = `<img src="${imageSrc}" width="${maxWidth}" alt="Image Preview" />`;
                    if (filePathForOpen) {
                        const args = encodeURIComponent(JSON.stringify([filePathForOpen]));
                        const cmd = `command:datex2.openExternalFile?${args}`;
                        imageHtml = `<a href="${cmd}" title="Open in System Viewer">${imageHtml}</a>`;
                    }
                    md.appendMarkdown(`**Data URI Image${sizeInfo}**\n\n${imageHtml}`);
                    return new vscode.Hover(md);
                }
            }
            
            // 2. CSS Files
            const cssRegex = /(?:css|css360)\s*:\s*(\[[^\]]*\]|"[^"]*"|'[^']*')/g;
            while ((match = cssRegex.exec(text))) {
                  const arrayOrString = match[1];
                  const arrayStart = match.index + match[0].indexOf(arrayOrString);
                  const strRegex = /(['"])(.*?)\1/g;
                  let strMatch;
                  while ((strMatch = strRegex.exec(arrayOrString))) {
                       const linkText = strMatch[2];
                       if (!linkText.endsWith('.css') && !linkText.endsWith('.gz')) continue;

                       const localStart = strMatch.index + 1;
                       const absStart = arrayStart + localStart;
                       const absEnd = absStart + linkText.length;
                       
                       if (position.character >= absStart && position.character <= absEnd) {
                            const resolved = await resolvePath(linkText);
                            if (resolved) {
                                const sizeMd = getFileSizeMarkdown(resolved);
                                const md = new vscode.MarkdownString();
                                md.appendMarkdown(`**${path.basename(resolved)}** ${sizeMd}`);
                                return new vscode.Hover(md);
                            }
                       }
                  }
            }

            // 3. Thumbs / Generic / Relative Paths
            // Combine strict thumbs check + generic path check into one pass or separate
            const pathsRegex = /["'](\.|\/)?\/?((?:thumbs|db|website|tools)\/[^"']+\.[a-zA-Z0-9]+)["']/g;
            while ((match = pathsRegex.exec(text))) {
                const innerPath = match[2];
                const start = match.index + match[0].indexOf(innerPath);
                const end = start + innerPath.length;
                
                if (position.character >= start && position.character <= end) {
                     const resolved = await resolvePath(innerPath);
                     if (resolved) {
                         const sizeMd = getFileSizeMarkdown(resolved);
                         const isImage = /\.(webp|png|jpg|jpeg|svg|gif)$/i.test(resolved);
                         
                         const md = new vscode.MarkdownString();
                         md.supportHtml = true; md.isTrusted = true;

                         md.appendMarkdown(`**${path.basename(resolved)}** ${sizeMd}`);
                         
                         if (isImage) {
                             const config = vscode.workspace.getConfiguration('datex2.hover.thumbs');
                             if (config.get('enabled')) {
                                const maxWidth = config.get('maxWidth') || 300;
                                const fileUri = vscode.Uri.file(resolved);
                                const args = encodeURIComponent(JSON.stringify([resolved]));
                                const cmd = `command:datex2.openExternalFile?${args}`;
                                md.appendMarkdown(`\n\n<a href="${cmd}" title="Open in System Viewer"><img src="${fileUri.toString()}" width="${maxWidth}" alt="Preview" /></a>`);
                             }
                         }
                         
                         return new vscode.Hover(md);
                     }
                }
            }

            return null;
        }
    }));

    context.subscriptions.push(vscode.languages.registerDocumentLinkProvider(['json', 'javascript', 'html', 'css', 'scss', 'less'], provider));

    // Remove old definition provider for thumbs to avoid conflict/double-behavior


    // Terminal Link Provider
    context.subscriptions.push(vscode.window.registerTerminalLinkProvider({
        provideTerminalLinks: (context, token) => {
            const regex = /file:\/\/\$\{([^}]+)\}([^"'\s]*)/g;
            const links = [];
            let match;
            while ((match = regex.exec(context.line))) {
                links.push({
                    startIndex: match.index,
                    length: match[0].length,
                    varName: match[1],
                    remainder: match[2]
                });
            }
            return links;
        },
        handleTerminalLink: (link) => {
            outputChannel.appendLine(`Handle terminal link: var=${link.varName}, remainder=${link.remainder}`);
            const config = vscode.workspace.getConfiguration();
            const varValue = config.get(link.varName);
            if (varValue && typeof varValue === 'string') {
                 let filePathPart = link.remainder;
                 const lineMatch = /:(\d+)/.exec(filePathPart);
                 let line = 0;
                 if (lineMatch) {
                     line = parseInt(lineMatch[1]);
                     const idx = filePathPart.lastIndexOf(':' + lineMatch[1]);
                     if (idx !== -1) filePathPart = filePathPart.substring(0, idx);
                 } else {
                     const hashIdx = filePathPart.indexOf('#');
                     if (hashIdx !== -1) filePathPart = filePathPart.substring(0, hashIdx);
                 }
                 
                 let combined = path.join(varValue, filePathPart);
                 outputChannel.appendLine(`Opening terminal link: ${combined}`);
                 vscode.workspace.openTextDocument(combined).then(doc => {
                     vscode.window.showTextDocument(doc, { selection: line > 0 ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined });
                 }, err => {
                     outputChannel.appendLine(`Error opening doc: ${err}`);
                 });
            }
        }
    }));

    // --- Fast Toggle Logic ---
    const fs = require('fs');

    const getKeyVal = (line) => {
        const kMatch = line.match(/^\s*(?:["']?([\w-]+)["']?\s*:|([\w-]+)\s*\(?)/);
        const vMatch = line.match(/:\s*(?:["']([^"']*)["']|([\d.-]+)|(true|false|null))/);
        return { 
            key: kMatch ? (kMatch[1]||kMatch[2]) : null, 
            val: kMatch ? (vMatch ? (vMatch[1]||vMatch[2]||vMatch[3]) : null) : null 
        };
    };

    const getIndent = (s) => { 
        let l = 0; 
        while(l < s.length && s[l] === ' ') l++; 
        return l; 
    };

    function parseLines(rawLines) {
        return rawLines.map((txt, i) => {
            const indent = getIndent(txt);
            const kv = getKeyVal(txt);
            return { i, txt, indent, k: kv.key, v: kv.val, idents: null };
        });
    }

    function getIdentities(parsedLines, startIndex, indent, cache) {
        let p = startIndex;
        while (p > 0 && parsedLines[p-1].indent === indent && parsedLines[p-1].txt.trim()) {
            p--;
        }
        if (cache && cache.has(p)) return cache.get(p);

        const identities = {};
        const start = p;
        
        while (p < parsedLines.length) {
            const line = parsedLines[p];
            if (!line.txt.trim()) { p++; continue; }
            if (line.indent < indent) break;
            if (line.indent === indent) {
                 if (line.k && ['id', 'name', 'text', 'sku', 'quantity'].includes(line.k)) {
                     if (!identities[line.k]) identities[line.k] = line.v;
                 }
            }
            p++;
        }
        
        if (cache) cache.set(start, identities);
        return identities;
    }

    // Helper: If cursor is within a stringified JSON object (like "{id:123,p:456}"),
    // extract which property the cursor is on
    function extractSubPropertyFromString(lineText, cursorCol) {
        const valueStart = lineText.indexOf('{');
        if (valueStart === -1 || cursorCol <= valueStart) return null;
        
        // Calculate position within the stringified object
        const relativePos = cursorCol - valueStart;
        
        // Extract the string (till closing }  or end of string)
        let objString = '';
        let depth = 0;
        for (let i = valueStart; i < lineText.length; i++) {
            const ch = lineText[i];
            if (ch === '{') depth++;
            if (ch === '}') {
                depth--;
                objString += ch;
                if (depth === 0) break;
            } else {
                objString += ch;
            }
        }
        
        if (objString.length === 0) return null;
        
        // Now parse the object string to find properties
       // Match patterns like: id:123, or p:'text', or s:"text"
        const propRegex = /(\w+)\s*:/g;
        let match;
        let properties = [];
        
        while ((match = propRegex.exec(objString)) !== null) {
            const propKey = match[1];
            const propStartIdx = match.index; // Position of key start in objString
            const colonPos = match.index + match[0].length - 1; // Position of ':'
            
            // Find where the value ends (next comma or closing brace)
            let valueEnd = objString.length;
            let searchFrom = colonPos + 1;
            let inQuote = false;
            let quoteChar = null;
            
            for (let i = searchFrom; i < objString.length; i++) {
                const ch = objString[i];
                if (!inQuote && (ch === '"' || ch === "'")) {
                    inQuote = true;
                    quoteChar = ch;
                } else if (inQuote && ch === quoteChar && objString[i-1] !== '\\') {
                    inQuote = false;
                } else if (!inQuote && (ch === ',' || ch === '}')) {
                    valueEnd = i;
                    break;
                }
            }
            
            properties.push({
                key: propKey,
                startIdx: propStartIdx,
                colonIdx: colonPos,
                valueEndIdx: valueEnd
            });
        }
        
        // Find which property the cursor is on
        for (let prop of properties) {
            // Cursor on key (before colon)
            if (relativePos >= prop.startIdx && relativePos < prop.colonIdx) {
                return {
                    key: prop.key,
                    keyStartCol: valueStart + prop.startIdx
                };
            }
            // Cursor on value
            if (relativePos >= prop.colonIdx + 1 && relativePos <= prop.valueEndIdx) {
                const valStart = prop.colonIdx + 1;
                const valOffset = Math.max(0, relativePos - valStart);
                return {
                    key: prop.key,
                    valStartCol: valueStart + valStart,
                    valOffset: valOffset
                };
            }
        }
        
        return null;
    }

    function getContextStack(parsedLines, lineIdx, cache) {
        let stack = [];
        let currentLineIdx = lineIdx;
        
        if (currentLineIdx >= parsedLines.length) currentLineIdx = parsedLines.length - 1;
        let currentLine = parsedLines[currentLineIdx];
        while ((!currentLine || !currentLine.txt.trim()) && currentLineIdx > 0) {
            currentLineIdx--;
            currentLine = parsedLines[currentLineIdx];
        }
        
        let ptr = currentLineIdx;
        let levelIndent = currentLine.indent;
        
        if (currentLine.k) {
            stack.unshift({ type: 'prop', key: currentLine.k, val: currentLine.v });
        }
        
        while (ptr >= 0) {
            let blockStart = ptr;
            
            let identities = {};
            if (levelIndent >= 0) {
                identities = getIdentities(parsedLines, ptr, levelIndent, cache);
            }
            
            while (blockStart >= 0) {
                 const line = parsedLines[blockStart];
                 if (line.indent < levelIndent && line.txt.trim()) break;
                 blockStart--;
            }
            
            let parentKey = '~root';
            if (blockStart >= 0) {
                 const parentLine = parsedLines[blockStart];
                 parentKey = parentLine.k || '~item'; 
                 levelIndent = parentLine.indent;
            } else {
                 levelIndent = -1;
            }
            
            if (Object.keys(identities).length > 0 || parentKey === '~item') {
                 stack.unshift({ type: 'scope', key: parentKey, identities });
            } else {
                 stack.unshift({ type: 'scope', key: parentKey });
            }
            
            if (blockStart < 0) break;
            ptr = blockStart;
        }
        return stack;
    }

    function normalizeStack(stack) {
        if (stack.length === 0) return stack;
        let newStack = [...stack];
        const last = newStack[newStack.length - 1];
        
        if (last.type === 'prop' && /^[a-z]{2}$/.test(last.key)) {
            newStack.pop(); 
            if (newStack.length > 0) {
                 const parent = newStack[newStack.length - 1];
                 if (parent.key && parent.key.endsWith('Translated')) {
                     parent.aliases = [parent.key, parent.key.replace('Translated', '')];
                 }
            }
        } else if (last.type === 'prop' && last.key && last.key.endsWith('Translated')) {
             last.aliases = [last.key, last.key.replace('Translated', '')];
        }
        
        // Map linkedProduct to cy
        stack.forEach(item => {
            if (item.key === 'linkedProduct') item.aliases = ['linkedProduct', 'cy'];
            if (item.key === 'cy') item.aliases = ['cy', 'linkedProduct'];
        });
        
        return newStack;
    }

    function findBestLine(rawLines, searchStack, sourceCol) {
        const parsedLines = parseLines(rawLines);
        const blockCache = new Map();
        let candidates = [];
        
        const leaf = searchStack[searchStack.length-1];
        const isValueFocus = (leaf.valStartCol && sourceCol >= leaf.valStartCol);

        for (let i = 0; i < parsedLines.length; i++) {
            const line = parsedLines[i];
            
            const candStack = getContextStack(parsedLines, i, blockCache);
            
            // Compare stacks
            let mismatch = false;
            let score = 0;
            
            let sIdx = 0;
            let cIdx = 0;
            let deepestMatchSIdx = -1;
            
            while (sIdx < searchStack.length && cIdx < candStack.length) {
                const sNode = searchStack[searchStack.length - 1 - sIdx];
                const cNode = candStack[candStack.length - 1 - cIdx];
                
                // --- IDENTITY CHECK ---
                if (sNode.identities) {
                     let cIdentities = cNode.identities || {};
                     // Ad-hoc extraction from one-liners ONLY for leaf scope (sIdx === 0)
                     // For parent scopes, the line text doesn't represent that scope's data
                     if (sIdx === 0 && Object.keys(cIdentities).length === 0 && line.txt.includes('{')) {
                         const idMatch = line.txt.match(/id\s*:\s*(?:["']?)([^"'\s,]+)(?:["']?)/);
                         if (idMatch) cIdentities = { ...cIdentities, id: idMatch[1] };
                         const nameMatch = line.txt.match(/name\s*:\s*(["'])(.*?)\1/);
                         if (nameMatch) cIdentities = { ...cIdentities, name: nameMatch[2].trim() };
                         const skuMatch = line.txt.match(/sku\s*:\s*(["'])(.*?)\1/);
                         if (skuMatch) cIdentities = { ...cIdentities, sku: skuMatch[2].trim() };
                     }

                     if (Object.keys(cIdentities).length > 0) {
                        for (const [k, v] of Object.entries(sNode.identities)) {
                             if (cIdentities[k]) {
                                 const sVal = String(v).trim().replace(/['"]/g, '');
                                 const cVal = String(cIdentities[k]).trim().replace(/['"]/g, '');
                                 if (sVal !== cVal) {
                                     mismatch = true;
                                     break;
                                 } else {
                                     score += 20; 
                                 }
                             }
                        }
                     }
                }
                if (mismatch) break;

                // Check key match
                const sKeys = sNode.aliases || (sNode.key ? [sNode.key] : []);
                if (sNode.key === '~item') sKeys.push('~item');
                
                let keyMatch = sKeys.includes(cNode.key);
                // Allow fuzzy match for "Translated" suffix
                if (!keyMatch && cNode.key && sKeys.includes(cNode.key.replace('Translated', ''))) keyMatch = true;
                
                // Allow module <-> ~item equivalence (JS module.exports vs JSON root object)
                if (!keyMatch && ((sNode.key === 'module' && cNode.key === '~item') || 
                                  (sNode.key === '~item' && cNode.key === 'module'))) {
                    keyMatch = true;
                }
                
                // Handle textTranslated layer skipping
                if (!keyMatch && sNode.key === 'textTranslated') {
                    sIdx++;
                    continue; 
                }
                if (!keyMatch && cNode.key === 'textTranslated') {
                    cIdx++; 
                    continue;
                }

                // Handle merged property in one-liner
                if (!keyMatch && sNode.type === 'prop') {
                     let found = false;
                     for (const key of sKeys) {
                         const regex = new RegExp(`(?:^|\\s|,|{)(?:["']?)${key}(?:["']?)\\s*:`);
                         if (regex.test(line.txt)) {
                             found = true;
                             break;
                         }
                     }
                     if (found) {
                         sIdx++;
                         score += 5;
                         continue;
                     }
                }

                // Handle merged item scope in one-liner
                if (!keyMatch && sNode.key === '~item' && sNode.identities) {
                     sIdx++;
                     continue;
                }
                
                if (!keyMatch && sNode.key !== '~item' && cNode.key !== '~item') {
                    // Mismatch?
                    // FALLBACK: One-Liner detection (JS Target)
                    // If we are at the leaf or near it, check if the line actually contains the key we want
                    // This handles { id: 1, name: 'foo' } where parsed key is 'id' but we want 'name'.
                    
                    // We only try this if the scopes matched so far (deepestMatchSIdx was updated previously)
                    // Actually, if we are mismatching here, we haven't updated deepestMatch for THIS node yet.
                    
                    let recovered = false;
                    if (parsedLines[i].txt) {
                         // Check if any of sKeys exist in the line as a property key
                         for (const sk of sKeys) {
                             // Check for "key": or key: or 'key':
                             const regex = new RegExp(`(?:^|\\s|,|{)(?:["']?)${sk}(?:["']?)\\s*:`);
                             if (regex.test(parsedLines[i].txt)) {
                                 recovered = true;
                                 score += 5; // Small bonus for finding it inline
                                 break;
                             }
                         }
                    }
                    
                    if (!recovered) {
                        mismatch = true;
                        break;
                    }
                }
                
                deepestMatchSIdx = sIdx;
                score += 10;
                sIdx++;
                cIdx++;
            }
            
            if (!mismatch) {
                // ... (Logic for looking deeper into the line for remaining stack items)
                let extraOffset = 0;
                const remainingStackItems = searchStack.slice(0, searchStack.length - 1 - deepestMatchSIdx).reverse();
                
                if (remainingStackItems.length > 0) {
                    let textToSearch = line.txt;
                    let foundAll = true;
                    let currentBase = 0;
                    
                    for (let item of remainingStackItems) {
                        if (item.key) {
                            const keyPattern = '(?:\\\\\\\\\\\\"|["\']?)' + item.key + '(?:\\\\\\\\\\\\"|["\']?)\\s*:';
                            const regex = new RegExp(keyPattern);
                            const match = regex.exec(textToSearch.substring(currentBase));
                            
                            if (match) {
                                const idx = currentBase + match.index;
                                currentBase = idx + match[0].length;
                                extraOffset = idx; 
                                const subMatch = match[0].match(new RegExp(item.key));
                                if (subMatch) {
                                     extraOffset = idx + subMatch.index;
                                }
                            } else {
                                const idx = textToSearch.indexOf(item.key, currentBase);
                                if (idx !== -1) {
                                    currentBase = idx + item.key.length;
                                    extraOffset = idx; 
                                } else {
                                    foundAll = false; 
                                }
                            }
                        }
                    }
                    if (foundAll) score += 5; 
                }
                
                const indent = line.indent;
                let col = indent + 1;
                const keyIndex = line.txt.indexOf(line.k);
                
                // If we 'recovered' via one-liner check above, our 'line.k' might range to the first key 'id'.
                // We should try to point col to the actual key we looked for (the leaf sNode.key).
                // Use sNode from top of searchStack (searchStack[searchStack.length-1])
                const targetKey = leaf.key;
                if (targetKey) {
                    // Try to find targetKey in line
                     const regex = new RegExp(`(?:^|\\s|,|{)(?:["']?)(${targetKey})(?:["']?)\\s*:`);
                     const m = line.txt.match(regex);
                     if (m) {
                         // m.index is start of match. m[1] is the key capture.
                         // We want position of key.
                         // Calculate offset of group 1
                         const matchStart = m.index;
                         const keyStartInMatch = m[0].indexOf(m[1]);
                         col = matchStart + keyStartInMatch + 1;
                     }
                } else {
                     if (keyIndex >= 0) col = keyIndex + 1;
                }
                
                if (isValueFocus) {
                     // Try to find value part for the specific key
                     // If we have targetKey, look for colon after it
                     if (targetKey) {
                         const regex = new RegExp(`(?:["']?)${targetKey}(?:["']?)\\s*:\\s*(?:["']?)`);
                         const m = line.txt.match(regex);
                         if (m) {
                             col = m.index + m[0].length + 1;
                         }
                     }
                }
                
                // Apply extra offset if we drilled down using remainingStackItems
                if (extraOffset > 0) {
                    col = extraOffset + 1; 
                }

                candidates.push({ line: i+1, col: col, score });
            }
        }
        
        if (candidates.length === 0) {
            if (searchStack.length > 1) {
                 return findBestLine(rawLines, searchStack.slice(0, -1), sourceCol);
            }
            return { line: 1, col: 1 };
        }
        //Sort by Score desc
        candidates.sort((a,b) => b.score - a.score);
        return candidates[0];
    }

    context.subscriptions.push(vscode.commands.registerCommand('datex2.toggleProductFile', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const document = editor.document;
        const filePath = document.fileName;
        const selection = editor.selection.active;
        const line = selection.line + 1; 
        const col = selection.character + 1; 

        if (!filePath) return;

        const currentLineText = document.lineAt(selection.line).text;

        // --- Check for Thumbs / Definition Trigger (F12 override) ---
        // If we are on a thumb path, delegate to the DefinitionProvider
        const thumbRegex = /["']((?:\.?\/)?thumbs\/[^"']+\.(webp|png|jpg|jpeg))["']/;
        if (document.getWordRangeAtPosition(selection, thumbRegex)) {
            vscode.commands.executeCommand('editor.action.revealDefinition');
            return;
        }
        if (document.fileName.endsWith('thumbs.json')) {
             const jsonKeyRegex = /["']([^"']+\.(webp|png|jpg|jpeg))["']/;
             if (document.getWordRangeAtPosition(selection, jsonKeyRegex)) {
                  vscode.commands.executeCommand('editor.action.revealDefinition');
                  return;
             }
        }
        // -------------------------------------------------------------
        
        // 1. Navigation from JS/JSON -> HTML (on load('...'))
        // 1. Navigation from JS/JSON -> HTML (on load('...'))
        const loadMatch = currentLineText.match(/load\(\s*(['"])((?:(?!\1)[^\\]|\\.)*?)\1\s*\)/);
        if (loadMatch) {
            // Check if cursor is within the load(...) call
            const loadStart = loadMatch.index;
            const loadEnd = loadStart + loadMatch[0].length;
            
            const cursorCol = selection.character;
            
            if (cursorCol >= loadStart && cursorCol <= loadEnd) {
                const relPath = loadMatch[2].trim();
                const dir = path.dirname(filePath);
                const htmlPath = path.join(dir, relPath);
                
                if (fs.existsSync(htmlPath)) {
                    const doc = await vscode.workspace.openTextDocument(htmlPath);
                    await vscode.window.showTextDocument(doc);
                    return;
                } else {
                    vscode.window.showWarningMessage(`Could not find HTML file: ${htmlPath}`);
                }
            }
        }

        // 2. Navigation from HTML -> JS (Find where this file is loaded)
        const ext = path.extname(filePath);
        if (ext === '.html') {
             // Look for product.js in parent directories
             let currentDir = path.dirname(filePath);
             let foundProductFile = null;
             
             // Go up at most 3 levels to find product.js or similar
             for (let i = 0; i < 3; i++) {
                 const pjs = path.join(currentDir, 'product.js');
                 if (fs.existsSync(pjs)) {
                     foundProductFile = pjs;
                     break;
                 }
                 // Try looking for named product file like BCx3-220VAC.js
                 const files = fs.readdirSync(currentDir);
                 const namedJs = files.find(f => f.endsWith('.js') && !f.startsWith('.'));
                 if (namedJs) {
                     // Check if this JS file loads our HTML file
                     const candidate = path.join(currentDir, namedJs);
                     const content = fs.readFileSync(candidate, 'utf8');
                     // We need to see if it loads the relative path to our HTML file
                     // Calculate relative path from candidate to filePath
                     // e.g. candidate: .../BCx3-220VAC.js, filePath: .../attributes/ChargingSpeedA.html
                     // rel: attributes/ChargingSpeedA.html
                     
                     // It might be loaded with different spacing or quotes, so let's rely on filename matching broadly or strict relative path
                     const relFromCand = path.relative(path.dirname(candidate), filePath).replace(/\\/g, '/');
                     
                     if (content.includes(relFromCand) || content.includes(path.basename(filePath))) {
                        foundProductFile = candidate;
                        break;
                     }
                 }
                 currentDir = path.dirname(currentDir);
             }
             
             if (foundProductFile) {
                 const doc = await vscode.workspace.openTextDocument(foundProductFile);
                 const text = doc.getText();
                 
                 // We want to find the exact load() call for this HTML file
                 // relPath might be "attributes/ChargingSpeedA.html"
                 // usage: load('attributes/ChargingSpeedA.html ') or similar
                 const relPath = path.relative(path.dirname(foundProductFile), filePath).replace(/\\/g, '/');
                 const filename = path.basename(filePath);
                 
                 // Regex to escape special chars in relPath
                 const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                 
                 // Try exact path first (handling potential trailing space in usage)
                 // Match: load('...path...')
                 const relPathPattern = new RegExp(`load\\s*\\(\\s*(['"])((?:(?!\\1)[^\\\\]|\\\\.)*?${escapeRegExp(relPath)}.*?)\\1\\s*\\)`);
                 const exactMatch = text.match(relPathPattern);
                 
                 let index = -1;
                 
                 if (exactMatch) {
                     index = exactMatch.index;
                 } else {
                      // Fallback: try just filename match in a load call
                      const filenamePattern = new RegExp(`load\\s*\\(\\s*(['"])((?:(?!\\1)[^\\\\]|\\\\.)*?${escapeRegExp(filename)}.*?)\\1\\s*\\)`);
                      const fileMatch = text.match(filenamePattern);
                      if (fileMatch) {
                          index = fileMatch.index;
                      }
                 }

                 if (index !== -1) {
                     const editor = await vscode.window.showTextDocument(doc);
                     const pos = doc.positionAt(index);
                     editor.selection = new vscode.Selection(pos, pos);
                     editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                     return;
                 }
             }
         }


        const dir = path.dirname(filePath);
        const basement = path.basename(filePath, ext);
        let targetPath = null;
        const isSourceJs = (ext === '.js');

        if (isSourceJs) {
            // JS -> JSON
            // Current is slug.ID.js or slug.js
            // Target is slug.ID.json or slug.json
            const jsonFile = basement + '.json'; // slug.ID.json
            if (fs.existsSync(path.join(dir, jsonFile))) {
                targetPath = path.join(dir, jsonFile);
            } else {
                // If we are slug.js, look for slug.ID.json
                // basement=slug
                const files = fs.readdirSync(dir);
                const target = files.find(f => f.startsWith(basement + '.') && f.match(/\.\d+\.json$/));
                if (target) targetPath = path.join(dir, target);
                // else check standard matching name?
                else if (fs.existsSync(path.join(dir, basement + '.json'))) targetPath = path.join(dir, basement + '.json');
            }
        } else if (ext === '.json') {
            // JSON -> JS
            // Current is slug.ID.json or slug.json
            const jsFile = basement + '.js'; // slug.ID.js
            if (fs.existsSync(path.join(dir, jsFile))) {
                targetPath = path.join(dir, jsFile);
            } else {
                // Remove ID suffix to find slug?
                // If basement = slug.ID
                const baseParts = basement.split('.');
                if (baseParts.length > 1 && /^\d+$/.test(baseParts[baseParts.length - 1])) {
                     baseParts.pop(); // Remove ID
                     const slug = baseParts.join('.');
                     // Check for slug.ID.js (maybe different ID? unlikely) or slug.js
                     const files = fs.readdirSync(dir);
                     const target = files.find(f => f.match(new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.js$`)));
                     if (target) targetPath = path.join(dir, target);
                     else if (fs.existsSync(path.join(dir, slug + '.js'))) targetPath = path.join(dir, slug + '.js');
                } else {
                    // basement = slug (old format)
                    // Look for slug.ID.js
                     const files = fs.readdirSync(dir);
                     const target = files.find(f => f.match(new RegExp(`^${basement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.js$`)));
                     if (target) targetPath = path.join(dir, target);
                }
            }
        }

        if (!targetPath) {
            // Keep silent if we are in HTML and didn't find anything, don't show "No matching pair" for HTML source unless we want to.
            // But if we are here, we fell through HTML logic.
            if (ext !== '.html') {
                 vscode.window.showInformationMessage('No matching pair file found.');
            }
            return;
        }

        let targetContent = "";
        try {
             targetContent = fs.readFileSync(targetPath, 'utf8');
        } catch (e) {
            vscode.window.showErrorMessage('Could not read target file.');
            return;
        }

        const sourceLines = document.getText().split(/\r?\n/);
        const targetLines = targetContent.split(/\r?\n/);

        const parsedSourceLines = parseLines(sourceLines);
        const sourceStack = getContextStack(parsedSourceLines, line - 1, new Map());
        
        // --- Generic Sub-property Handling ---
        // If we represent a complex object on one line (like inside attributes array),
        // getContextStack might just see the first key. We want the specific key under cursor.
        const subProp = extractSubPropertyFromString(currentLineText, col - 1);
        if (subProp) {
            // subProp found! We are likely in a one-line object like { id:..., name:..., value:... }
            // 1. Identify "identities" from this line (id, sku, name) to help matching target
            const lineIdentities = {};
            const idMatch = currentLineText.match(/id\s*:\s*(\d+)/);
            if (idMatch) lineIdentities['id'] = idMatch[1];
            
            const nameMatch = currentLineText.match(/name\s*:\s*(["'])(.*?)\1/);
            if (nameMatch) lineIdentities['name'] = nameMatch[2];

            // 2. Fix the stack
            // Current stack might be [...parent, prop: 'id'] or similar.
            // We want [...parent, scope: '~item', prop: subProp.key]
            
            // Pop the last item if it looks like a false leaf (e.g. 'id' detected by simplistic parser)
            if (sourceStack.length > 0) {
                 const last = sourceStack[sourceStack.length - 1];
                 // If the last item is a Prop that exists on this line, we replace it with ~item + subProp
                 if (last.type === 'prop' && currentLineText.includes(last.key)) {
                     sourceStack.pop();
                 }
            }
            
            // Add Scope (~item) with identities
            sourceStack.push({
                type: 'scope',
                key: '~item',
                identities: lineIdentities
            });
            
            // Add the actual property we are on
            sourceStack.push({
                type: 'prop',
                key: subProp.key,
                valStartCol: subProp.valStartCol,
                valOffset: subProp.valOffset
            });
        }

        const normalizedStack = normalizeStack(sourceStack);
        
        let sourceValStartCol = 0;
        let valOffset = 0;
        if (sourceLines[line-1]) {
            const sl = sourceLines[line-1];
            const match = sl.match(/:\s*(?:["']?)/);
            if (match) {
                sourceValStartCol = match.index + match[0].length + 1;
                if (col >= sourceValStartCol) {
                    valOffset = col - sourceValStartCol;
                }
            }
        }
        if (normalizedStack.length > 0) {
             normalizedStack[normalizedStack.length-1].valStartCol = sourceValStartCol;
             normalizedStack[normalizedStack.length-1].valOffset = valOffset;
        }

        const best = findBestLine(targetLines, normalizedStack, col);

        const targetUri = vscode.Uri.file(targetPath);
        const doc = await vscode.workspace.openTextDocument(targetUri);
        const newEditor = await vscode.window.showTextDocument(doc, { preview: false }); 
        
        const newPos = new vscode.Position(best.line - 1, best.col - 1);
        newEditor.selection = new vscode.Selection(newPos, newPos);
        newEditor.revealRange(new vscode.Range(newPos, newPos), vscode.TextEditorRevealType.InCenter);
    }));

    // --- Translation Toggle Logic (Ctrl+F12) ---
    /* context.subscriptions.push(vscode.commands.registerCommand('datex2.toggleTranslationFile', async () => {
        try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const document = editor.document;
        const filePath = document.fileName;
        const selection = editor.selection.active;
        const lineIdx = selection.line;
        const colIdx = selection.character;
        const currentLineText = document.lineAt(lineIdx).text;

        const cacheFilePath = 'db/translations/translations.ai.cache.json'; 
        
        // Helper to find root dir
        const getRootDir = (startPath) => {
            let current = path.dirname(startPath);
            while (current !== path.parse(current).root) {
                if (fs.existsSync(path.join(current, 'website'))) return current;
                current = path.dirname(current);
            }
            return null;
        };

        const rootDir = getRootDir(filePath);
        if (!rootDir) {
             vscode.window.showWarningMessage('Could not find project root (looking for website folder).');
             return;
        }
        const absoluteCachePath = path.join(rootDir, cacheFilePath);

        // Scenario 1: We are IN the cache file, want to go back to source
        if (filePath.toLowerCase().endsWith('translations.ai.cache.json')) {
                // Use helper to resolve refs
                const refs = getTranslationRefs(document, lineIdx);
                if (refs.length > 0) {
                    const locations = await resolveRefsToLocations(refs, rootDir);
                    
                    // Smart navigation: Try to match current source file
                     // Current File Slug
                    const currentSlug = path.basename(path.dirname(document.fileName));
                    // Current Line (1-based because refs are 1-based)
                    const currentLine = selection.active.line + 1;
                    
                    let bestLoc = locations[0];
                    
                    // Try to find exact match
                    const exactMatch = locations.find(l => {
                        const fsPath = l.uri.fsPath;
                        return path.basename(fsPath) === document.fileName; // simple filename match
                        // Better: check if fsPath includes currentSlug and line is close?
                        // Actually, if we are going Cache -> Source, we usually want the FIRST ref or a list.
                        // But wait, the user said "Toggle". If I am in Cache, Toggle should bring me back to Source.
                        // If I have multiple sources, which one?
                        // History based? Or Reference based?
                        // If we don't have history, maybe just the first one.
                    });
                    
                    if (exactMatch) bestLoc = exactMatch;
                    
                    if (bestLoc) {
                         const doc = await vscode.workspace.openTextDocument(bestLoc.uri);
                         const editor = await vscode.window.showTextDocument(doc);
                         editor.selection = new vscode.Selection(bestLoc.range.start, bestLoc.range.end);
                         editor.revealRange(bestLoc.range, vscode.TextEditorRevealType.InCenter);
                         return;
                    }
                } else {
                     vscode.window.showInformationMessage("No references found for this translation entry.");
                     return;
                }
            }
            
            // Scenario 2: We are in a SOURCE file, want to go to cache
            // 1. Identify the text to search. 
            //    - If cursor is inside a string value, use that string.
            //    - If cursor is on a key (e.g. "seoTitle "), use the key (trimmed?).
            
            let searchText = null;
            
            // Try to extract string under cursor
            const wordRange = document.getWordRangeAtPosition(selection, /(["'])((?:(?!\1)[^\\]|\\.)*?)\1/);
            if (wordRange) {
                const text = document.getText(wordRange);
                // Strip quotes
                searchText = text.substring(1, text.length - 1);
            } else {
                // Try key match
                const kv = getKeyVal(currentLineText);
                if (kv.key) searchText = kv.key.trim(); // Handle trailing space convention?
                if (!searchText && kv.val) searchText = String(kv.val);
            }
            
            if (!searchText || searchText.length < 2) {
                 vscode.window.showInformationMessage("Please place cursor on a translation key or string.");
                 return;
            }

            // Clean up searchText (e.g. remove "Translated" suffix maybe? User said "Translated" keys usually map to original keys)
            // But user also said keys in translations.ai.cache.json are the English text usually.
            // "seoTitle " -> "seoTitle" in cache? No, cache keys are the English phrase usually.
            // Wait, look at cache structure:
            // "21cm x 11cm": { ... }  <-- The key is the text itself.
            
            // So if in JS file: "name": "INPUT AC Plug ",  --> We search for "INPUT AC Plug" (trimmed)
            searchText = searchText.trim();

            if (!fs.existsSync(absoluteCachePath)) {
                vscode.window.showErrorMessage(`Translation cache file not found at ${absoluteCachePath}`);
                return;
            }

            const cacheContent = fs.readFileSync(absoluteCachePath, 'utf8');
            const cacheLines = cacheContent.split(/\r?\n/);
            
            // Search for the key in the cache file (at root level usually)
            // Regex to match:  "SEARCH_TEXT": {
            
            // Escape regex special chars in searchText
            const escapedSearch = searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const searchRegex = new RegExp(`^\\s*"${escapedSearch} ?"\\s*:`);
            
            let foundLine = -1;
            for (let i = 0; i < cacheLines.length; i++) {
                if (searchRegex.test(cacheLines[i])) {
                    foundLine = i;
                    break;
                }
            }
            
            if (foundLine !== -1) {
                const doc = await vscode.workspace.openTextDocument(absoluteCachePath);
                const editor = await vscode.window.showTextDocument(doc);
                
                let targetCol = 0;
                try {
                    // Calculate offset if we came from a string match
                    if (wordRange && selection) {
                        const relativeOffset = selection.character - wordRange.start.character;
                        const targetLineText = cacheLines[foundLine];
                        if (targetLineText) {
                            // Find start of key string in target line (first quote)
                            const quoteStart = targetLineText.indexOf('"');
                            if (quoteStart !== -1) {
                                targetCol = quoteStart + relativeOffset;
                                // Boundary check: don't go past the line length
                                if (targetCol > targetLineText.length) targetCol = targetLineText.length;
                            }
                        }
                    }
                } catch (err) {
                    console.error("Error calculating target cursor position:", err);
                    targetCol = 0; // Fallback to start of line
                }

                const pos = new vscode.Position(foundLine, targetCol);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            } else {
                vscode.window.showInformationMessage(`Translation entry "${searchText}" not found in cache.`);
            }
        }
        } catch (e) {
            vscode.window.showErrorMessage('Toggle Translation Error: ' + e.message);
            console.error(e);
        }
    })); */

    // --- Helper Functions for Refs ---
    function getTranslationRefs(document, lineIdx) {
        const text = document.getText();
        const lines = text.split(/\r?\n/);
        
        // Find the block corresponding to the line.
        // We look for the closest "refs": [...] block downwards, or upwards if we are inside a block.
        // Simplified: Search window around cursor.
        
        let startSearch = Math.max(0, lineIdx - 100);
        let endSearch = Math.min(lines.length, lineIdx + 100);
        
        let refs = [];
        let jsonStr = "";
        let collecting = false;
        
        // Strategy: Find the start of the object definition for this key, then find "refs" inside it.
        // Or naively find the closest "refs" block that seems to belong to the current indentation context.
        
        // Better: Identify the range of the current key-value pair in JSON.
        // Since it's a huge JSON, parsing whole file is slow.
        // We rely on the structure:
        // "Key": {
        //    "refs": [ ... ]
        // }
        
        // Scan downwards for "refs":
        for (let i = lineIdx; i < endSearch; i++) {
             if (lines[i].includes('"refs":')) {
                 collecting = true;
                 startSearch = i;
                 break;
             }
             // If we hit a new Top Level Key (starts with non-space or just indentation and "Key": {), stop.
             if (i > lineIdx && /^\s*"[^"]+":\s*\{/.test(lines[i])) return [];
        }
        
        // Check upwards if not found downwards (maybe we are INSIDE the refs list)
        if (!collecting) {
            for (let i = lineIdx; i >= startSearch; i--) {
                if (lines[i].includes('"refs":')) {
                    collecting = true;
                    startSearch = i;
                    break;
                }
                 if (/^\s*"[^"]+":\s*\{/.test(lines[i])) break; // Hit start of block
            }
        }

        if (collecting) {
             let j = startSearch;
             while (j < endSearch) {
                 jsonStr += lines[j];
                 if (lines[j].includes(']')) break;
                 j++;
             }
             const refsMatch = jsonStr.match(/"refs"\s*:\s*\[(.*?)\]/s);
             if (refsMatch) {
                const refsContent = refsMatch[1];
                const refItems = refsContent.match(/"([^"]+)"/g);
                if (refItems) {
                    refs = refItems.map(s => s.replace(/"/g, ''));
                }
             }
        }
        return refs;
    }

    async function resolveRefsToLocations(refs, rootDir) {
        const locations = [];
        
        // Cache found files to speed up multiple refs to same file
        const fileCache = new Map();

        for (const ref of refs) {
            let targetSrcPath = null;
            let refLine = 1;
            let refCol = 1;

            if (ref.includes('@')) {
                const regex = /(product):([^@]+)@([^/]+)\/([^#]+)(?:#.*)?|(profile|category)@([^/]+)\/([^#]+)(?:#.*)?/;
                const match = ref.match(regex);
                if (match) {
                    let type, host, pos;
                    if (match[1] === 'product') {
                         type = 'product';
                         host = match[2];
                         pos = match[3];
                    } else {
                         type = match[5];
                         host = '';
                         pos = match[6];
                    }
                    
                    const posParts = pos.split(':');
                    if (posParts.length > 0) refLine = parseInt(posParts[0]);
                    if (posParts.length > 1) refCol = parseInt(posParts[1]);
                    
                    if (type === 'product') {
                         if (fileCache.has(host)) {
                             targetSrcPath = fileCache.get(host);
                         } else {
                            const found = await vscode.workspace.findFiles(`db/products/**/${host}*.js`, '**/node_modules/**', 1);
                            if (found.length > 0) {
                                targetSrcPath = found[0].fsPath;
                                fileCache.set(host, targetSrcPath);
                            } else {
                                targetSrcPath = path.join(rootDir, `db/products/${host}/${host}.js`);
                            }
                         }
                    } else if (type === 'category') {
                         targetSrcPath = path.join(rootDir, 'db/categories/categories.js');
                    } else if (type === 'profile') {
                         targetSrcPath = path.join(rootDir, 'db/profile/profile.js');
                    }
                }
            } else if (ref.includes('://')) {
                 const parts = ref.split(':');
                 const refPathRel = parts[0];
                 refLine = parts.length > 1 ? parseInt(parts[1]) : 1;
                 targetSrcPath = path.join(rootDir, refPathRel);
            }
            
            if (targetSrcPath && fs.existsSync(targetSrcPath)) {
                // Ensure line is valid
                const safeLine = refLine > 0 ? refLine - 1 : 0;
                const safeCol = refCol > 0 ? refCol - 1 : 0;
                locations.push(new vscode.Location(
                    vscode.Uri.file(targetSrcPath),
                    new vscode.Range(safeLine, safeCol, safeLine, safeCol)
                ));
            }
        }
        return locations;
    }

    // --- Provider for Ctrl+Shift+F12 ---
    context.subscriptions.push(vscode.languages.registerImplementationProvider({ scheme: 'file', language: 'json', pattern: '**/translations.ai.cache.json' }, {
        async provideImplementation(document, position, token) {
             const refs = getTranslationRefs(document, position.line);
             if (!refs || refs.length === 0) return null;
             
             // Get Root
             const rootDir = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0 
                ? vscode.workspace.workspaceFolders[0].uri.fsPath 
                : path.dirname(document.fileName); // fallback
             
             return await resolveRefsToLocations(refs, rootDir);
        }
    }));


    // context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
    //     const doc = e.document;
    //     // Only target product JS files
    //     if (!doc.fileName.includes('products') || !doc.fileName.endsWith('.js')) return;
        
    //     // Find visible editor for this document
    //     const editor = vscode.window.visibleTextEditors.find(ed => ed.document === doc);
    //     if (!editor) return;

    //     // Heuristic: If contentChanges involve the entire file (start 0,0 to end), 
    //     // OR simply if we know these files are auto-generated, we trust the last known selection.
    //     // However, user might be typing.
        
    //     // Check if change is "Large" or "Whole File"
    //     // But simpler: If the change caused the cursor to jump to 0,0 (which happens on FS refresh usually), restore it.
    //     // We use a slightly longer timeout and multiple checks.
        
    //     setTimeout(() => {
    //          const key = doc.fileName.toLowerCase();
    //          const lastPos = lastSelections.get(key);
             
    //          // Blindly restore if we have a history, because we trust that
    //          // if the file was reloaded by our tools, the user wants to stay where they were.
    //          if (lastPos) {
    //              // Verify validity of position (in case file shrank)
    //              let newLine = lastPos.line;
    //              if (newLine >= doc.lineCount) newLine = doc.lineCount - 1;
    //              if (newLine < 0) newLine = 0;
                 
    //              const newPos = new vscode.Position(newLine, lastPos.character);
                 
    //              // Only verify if we are significantly far from target?
    //              // Or just force it. Force is better for stability.
    //              editor.selection = new vscode.Selection(newPos, newPos);
    //              editor.revealRange(new vscode.Range(newPos, newPos), vscode.TextEditorRevealType.InCenter);
    //          }
    //     }, 150); // Increased delay



    // --- Image Preview & Open Logic for Thumbnails ---
    // --- Image Preview, Open Logic & Autocomplete for Thumbnails ---
    // Dynamic THUMBS_DIR based on workspace
    const getThumbsDir = () => {
        const rootPath = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : '';
        return rootPath ? path.join(rootPath, 'thumbs') : '';
    };

    // Thumbs Registry Logic
    let thumbsRegistryCache = null;
    let thumbsLastModified = 0;
    let lastLoadedPath = '';

    const getThumbsRegistryPath = () => {
        const config = vscode.workspace.getConfiguration();
        const configuredPath = config.get('datex2.thumbsRegistryPath');
        if (configuredPath) return configuredPath;
        
        // Fallback or default? 
        // We can fallback to the hardcoded path if not set, or just return empty.
        // Given user request "hai să nu hardodăm", we should probably rely on config.
        // But for backward compatibility/immediate working state without manual config:
        return 'd:\\DATEx2.bike\\GitHub\\bikeRAW\\Thumbnails\\thumbs.json'; 
    };

    const getThumbsRegistry = () => {
        try {
            const registryPath = getThumbsRegistryPath();
            if (!registryPath || !fs.existsSync(registryPath)) return null;
            
            // Check if path changed dynamically
            if (registryPath !== lastLoadedPath) {
                thumbsRegistryCache = null;
                thumbsLastModified = 0;
                lastLoadedPath = registryPath;
            }

            const stats = fs.statSync(registryPath);
            if (thumbsRegistryCache && stats.mtimeMs === thumbsLastModified) {
                return thumbsRegistryCache;
            }
            const content = fs.readFileSync(registryPath, 'utf8');
            thumbsRegistryCache = JSON.parse(content);
            thumbsLastModified = stats.mtimeMs;
            return thumbsRegistryCache;
        } catch (e) {
            console.error("Error reading thumbs.json", e);
            return null;
        }
    };

    const getProductsForImage = (imageName) => {
        const registry = getThumbsRegistry();
        if (!registry) return [];

        const productsMap = new Map(); // slug -> { slug, filePath, line, col }

        Object.values(registry).forEach(product => {
            if (product.thumbs) {
                Object.keys(product.thumbs).forEach(key => {
                    if (key.endsWith(imageName) || key.endsWith('/' + imageName)) {
                         const entry = product.thumbs[key];
                         let foundRef = false;

                         if (entry && entry.refs && Array.isArray(entry.refs)) {
                            entry.refs.forEach(ref => {
                                // ref format: path/to/Slug.js@line:col
                                const parts = ref.split('@');
                                const filePath = parts[0];
                                const pos = parts[1];
                                
                                const pathParts = filePath.split('/');
                                const slug = pathParts[pathParts.length - 1].replace('.js', '');
                                
                                if (!productsMap.has(slug)) {
                                    let line = 1, col = 1;
                                    if (pos) {
                                        const posParts = pos.split(':');
                                        if (posParts[0]) line = parseInt(posParts[0]);
                                        if (posParts[1]) col = parseInt(posParts[1]);
                                    }
                                    productsMap.set(slug, { slug, filePath, line, col });
                                }
                                foundRef = true;
                            });
                        }
                        
                        // Fallback if no refs (or only loose match)
                        if (!foundRef && product.slug) {
                             if (!productsMap.has(product.slug)) {
                                 productsMap.set(product.slug, { 
                                     slug: product.slug, 
                                     filePath: `db/products/${product.slug}/${product.slug}.js`, 
                                     line: 1, 
                                     col: 1 
                                });
                             }
                        }
                    }
                });
            }
        });
        return Array.from(productsMap.values()).sort((a,b) => a.slug.localeCompare(b.slug));
    };


    const PathCompletionProvider = {
        provideCompletionItems(document, position) {
            const range = document.getWordRangeAtPosition(position, /["']([^"']*)["']/);
            if (!range) return undefined;

            const fullString = document.getText(range);
            // content inside quotes
            const content = fullString.substring(1, fullString.length - 1);
            
            // Check if it looks like a thumbs path (empty or partial)
            // match: "", "/thumbs", "/thumbs/", "./thumbs/..."
            if (!content.includes('thumb')) return undefined;

            const thumbsDir = getThumbsDir();
            if (!thumbsDir || !fs.existsSync(thumbsDir)) return undefined;

            try {
                const files = fs.readdirSync(thumbsDir);
                
                // We will replace everything inside the quotes to ensure clean insertion
                const start = range.start.translate(0, 1);
                const end = range.end.translate(0, -1);
                const replaceRange = new vscode.Range(start, end);

                return files
                    .filter(f => /\.(webp|png|jpg|jpeg)$/i.test(f))
                    .map(file => {
                        const item = new vscode.CompletionItem(file, vscode.CompletionItemKind.File);
                        
                        // Smart insert text: maintain existing prefix style if possible
                        // But user typically wants full path. defaulting to standard relative path used in project.
                        // Project seems to use "thumbs/file.webp" or "./thumbs/file.webp" or "/thumbs/..."
                        // Let's stick to "/thumbs/" as implied by previous code or "thumbs/"
                        
                         // Fix: Ensure filterText matches the prefix user typed (e.g. ./thumbs/ vs /thumbs/)
                        if (content.startsWith('./')) {
                             item.insertText = `./thumbs/${file}`;
                             item.filterText = `./thumbs/${file}`;
                        } else if (content.startsWith('/')) {
                             item.insertText = `/thumbs/${file}`;
                             item.filterText = `/thumbs/${file}`;
                        } else {
                             item.insertText = `thumbs/${file}`;
                             item.filterText = `thumbs/${file}`;
                        }
                        
                        item.range = replaceRange;
                        item.sortText = file; 

                        const filePath = path.join(thumbsDir, file);
                        const products = getProductsForImage(file);
                        
                        let mdContent = `### ${file}\n\n`;
                        mdContent += `<img src="${vscode.Uri.file(filePath).toString()}" width="300" alt="${file}"/>\n\n`;
                        
                        if (products.length > 0) {
                            mdContent += `**Products:**\n`;
                            products.forEach(p => {
                                mdContent += `- ${p}\n`;
                            });
                        } else {
                            mdContent += `_(Not referenced in any known product)_\n`;
                        }

                        const markdown = new vscode.MarkdownString(mdContent);
                        markdown.supportHtml = true;
                        item.documentation = markdown;

                        return item;
                    });
            } catch (e) {
                console.error(e);
                return [];
            }
        }
    };

    // Trigger on / and usual chars for aggressive completion
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(['javascript', 'json'], PathCompletionProvider, '/', '"', '\'', 't', 'h', 'u', 'm', 'b', 's'));


    // --- Search Product By ID Logic ---
    context.subscriptions.push(vscode.commands.registerCommand('datex2.searchProductById', async () => {
        const input = await vscode.window.showInputBox({
            placeHolder: 'Enter Product ID (e.g. 532361501)',
            prompt: 'Search for a product file containing this ID'
        });

        if (!input) return;

        const targetId = input.trim();
        // Regex to match: id: 12345 or id: "12345" or id: '12345'
        const regex = new RegExp(`id\\s*:\\s*(["']?)${targetId}\\1`);

        try {
            const productFiles = await vscode.workspace.findFiles('db/products/**/*.js', '**/node_modules/**');
            
            let found = false;

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Searching for ID: ${targetId}...`,
                cancellable: true
            }, async (progress, token) => {
                
                for (const file of productFiles) {
                    if (token.isCancellationRequested) break;
                    
                    const content = fs.readFileSync(file.fsPath, 'utf8');
                    const match = content.match(regex);
                    
                    if (match) {
                        found = true;
                        const doc = await vscode.workspace.openTextDocument(file);
                        const editor = await vscode.window.showTextDocument(doc);
                        
                        // Find line number
                        const lines = content.split(/\r?\n/);
                        const lineIdx = lines.findIndex(l => regex.test(l));
                        
                        if (lineIdx !== -1) {
                            const pos = new vscode.Position(lineIdx, 0);
                            editor.selection = new vscode.Selection(pos, pos);
                            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                        }
                        
                        // Stop after first match? User implied "search", usually means unique ID. 
                        break; 
                    }
                }

                if (!found && !token.isCancellationRequested) {
                    vscode.window.showInformationMessage(`No product found with ID: ${targetId}`);
                }
            });

        } catch (e) {
            vscode.window.showErrorMessage('Error searching products: ' + e.message);
        }
    }));

    // --- Thumbs Cycling Logic (F12) ---
    context.subscriptions.push(vscode.languages.registerDefinitionProvider(['javascript', 'json'], {
        async provideDefinition(document, position, token) {
            // 1. Identify if we are on a thumb path
            // Regex for standard product files
            const thumbRegex = /["']((?:\.?\/)?thumbs\/[^"']+\.(webp|png|jpg|jpeg))["']/;
            let range = document.getWordRangeAtPosition(position, thumbRegex);
            let fileName = null;
            let offsetInFileName = 0;

            if (range) {
                const text = document.getText(range);
                // Extract filename from "thumbs/foo.webp"
                // Remove quotes
                const content = text.substring(1, text.length - 1);
                // content might be "thumbs/foo.webp" or "./thumbs/foo.webp"
                const parts = content.split('/');
                fileName = parts[parts.length - 1];
                
                // Calculate offset
                const fNameIdx = text.indexOf(fileName);
                if (fNameIdx !== -1) {
                    const cursorOffset = position.character - range.start.character;
                    offsetInFileName = Math.max(0, Math.min(fileName.length, cursorOffset - fNameIdx));
                }
            } else {
                // Fallback for thumbs.json context (keys might be just filenames or paths without 'thumbs/' prefix)
                if (document.fileName.endsWith('thumbs.json')) {
                    // Match simple filename string with extension
                    const jsonKeyRegex = /["']([^"']+\.(webp|png|jpg|jpeg))["']/;
                    range = document.getWordRangeAtPosition(position, jsonKeyRegex);
                    if (range) {
                        const text = document.getText(range);
                        let extracted = text.substring(1, text.length - 1);
                        // If it has slashes, check if it's a path key
                        if (extracted.includes('/')) {
                             const parts = extracted.split('/');
                             fileName = parts[parts.length - 1];
                        } else {
                            fileName = extracted;
                        }
                        
                        const fNameIdx = text.indexOf(fileName);
                        if (fNameIdx !== -1) {
                            const cursorOffset = position.character - range.start.character;
                            offsetInFileName = Math.max(0, Math.min(fileName.length, cursorOffset - fNameIdx));
                        }
                    }
                }
            }

            if (!fileName) return null;

            // 2. Get Registry
            const registryPath = getThumbsRegistryPath();
            if (!registryPath || !fs.existsSync(registryPath)) return null;

            const registry = getThumbsRegistry();
            if (!registry) return null;

            // 3. Find Entry
            let targetEntry = null;
            let targetEntryKey = null;

            for (const pKey in registry) {
                const product = registry[pKey];
                if (product.thumbs) {
                    for (const tKey in product.thumbs) {
                        if (tKey.endsWith(fileName) || tKey.endsWith('/' + fileName)) {
                            targetEntry = product.thumbs[tKey];
                            targetEntryKey = tKey;
                            break;
                        }
                    }
                }
                if (targetEntry) break;
            }

            if (!targetEntry) return null;

            // 4. Build Locations List (Main Key -> Refs)
            const locations = []; // { uri, range }

            // A. Add thumbs.json location (Main definition)
            try {
                const thumbsContent = fs.readFileSync(registryPath, 'utf8');
                const thumbsLines = thumbsContent.split(/\r?\n/);
                // Naive search for Key
                const keyEscaped = targetEntryKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const keyRegex = new RegExp(`"${keyEscaped}"\\s*:`);
                
                let lineIdx = -1;
                for (let i = 0; i < thumbsLines.length; i++) {
                    if (keyRegex.test(thumbsLines[i])) {
                        lineIdx = i;
                        break;
                    }
                }
                
                if (lineIdx !== -1) {
                    // Start position (will be refined if it's the target)
                    // Default to start of key
                    const lineText = thumbsLines[lineIdx];
                    const keyStart = lineText.indexOf(targetEntryKey);
                    let col = (keyStart !== -1) ? keyStart : 0;
                    
                    locations.push({
                        uri: vscode.Uri.file(registryPath),
                        range: new vscode.Range(lineIdx, col, lineIdx, col)
                    });
                }
            } catch (e) { console.error("Error reading thumbs.json for definition", e); }

            // B. Add Refs
            const rootPath = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : '';
            if (targetEntry.refs && Array.isArray(targetEntry.refs) && rootPath) {
                for (const ref of targetEntry.refs) {
                    // ref format: path/to/file.js@line:col
                    if (!ref.includes('@')) continue; // skip unexpected format
                    const parts = ref.split('@');
                    const relPath = parts[0];
                    const posStr = parts[1];
                    let line = 0; 
                    let col = 0;
                    
                    if (posStr) {
                        const p = posStr.split(':');
                        if (p[0]) line = parseInt(p[0]) - 1; // 1-based in string, 0-based in VSCode
                        if (p[1]) col = parseInt(p[1]) - 1;
                    }
                    
                    const absPath = path.join(rootPath, relPath);
                    locations.push({
                        uri: vscode.Uri.file(absPath),
                        range: new vscode.Range(line, col, line, col)
                    });
                }
            }

            if (locations.length === 0) return null;

            // 5. Determine Next Location
            const docUriStr = document.uri.toString();
            const curLine = position.line;
            
            let currentIndex = -1;
            
            // Find current location in list
            for (let i = 0; i < locations.length; i++) {
                const loc = locations[i];
                if (loc.uri.toString() === docUriStr) {
                    // Fuzzy match line (refs might be slightly off if file edited)
                    if (Math.abs(loc.range.start.line - curLine) <= 2) {
                        currentIndex = i;
                        break;
                    }
                }
            }

            // Logic:
            // If we are at a known location, go to next.
            // If unknown (new usage), go to Definition (thumbs.json, index 0).
            let nextIndex = 0;
            if (currentIndex !== -1) {
                nextIndex = (currentIndex + 1) % locations.length;
            }

            const target = locations[nextIndex];
            
            // 6. Refine Target Range with Offset
            // We want to land at fileName start + offsetInFileName
            try {
                // If it's thumbs.json, we already read it sort of, but let's be robust
                let lineText = '';
                if (target.uri.fsPath === registryPath) {
                    // Re-read or cache? Simple re-read for now or reuse cache logic if optimizing
                    // We can reuse the loop logic but simpler to just read line
                     const thumbsContent = fs.readFileSync(registryPath, 'utf8');
                     const thumbsLines = thumbsContent.split(/\r?\n/);
                     if (thumbsLines[target.range.start.line]) lineText = thumbsLines[target.range.start.line];
                } else {
                     if (fs.existsSync(target.uri.fsPath)) {
                         // Read only the needed line?
                         // For simplicity read file
                         const content = fs.readFileSync(target.uri.fsPath, 'utf8');
                         const lines = content.split(/\r?\n/);
                         if (lines[target.range.start.line]) lineText = lines[target.range.start.line];
                     }
                }

                if (lineText) {
                    // Find fileName in this line
                    // We expect it to be near valid target.range.start.character
                    // But naive indexOf is usually sufficient for these keys
                    const idx = lineText.indexOf(fileName);
                    if (idx !== -1) {
                        const newCol = idx + offsetInFileName;
                        return new vscode.Location(target.uri, new vscode.Range(target.range.start.line, newCol, target.range.start.line, newCol));
                    }
                }
            } catch(e) {}

            return new vscode.Location(target.uri, target.range);
        }
    }));

    // 15. Definition Provider (Ctrl+Click)
    context.subscriptions.push(vscode.languages.registerDefinitionProvider(['javascript', 'json'], {
        async provideDefinition(document, position, token) {
            const range = document.getWordRangeAtPosition(position, /\b\d{8,12}\b/);
            if (!range) return null;
            const id = document.getText(range);
            
            // 1. Try Product File
            let pPath = null;
            // Check Global Map
            if (global.datex2ProductMap && global.datex2ProductMap[id]) {
                pPath = global.datex2ProductMap[id];
            } else {
                 // Check Heuristic Search
                const pFiles = await vscode.workspace.findFiles(`db/products/**/*.${id}.js`, '**/node_modules/**', 1);
                if (pFiles.length > 0) pPath = pFiles[0].fsPath;
            }
            
            if (pPath) {
                 return new vscode.Location(vscode.Uri.file(pPath), new vscode.Position(0, 0));
            }
            
            // 2. Try Category & Types (Workspace Root context)
            const rootPath = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : null;
            if (rootPath) {
                // Category
                const catPath = path.join(rootPath, 'db/categories/categories.js');
                if (fs.existsSync(catPath)) {
                    try {
                        const content = fs.readFileSync(catPath, 'utf8');
                        const regex = new RegExp(`(?:["']?)\\bid\\b(?:["']?)\\s*:\\s*${id}\\b`); // Matches id: 123...
                        const match = regex.exec(content);
                        if (match) {
                            const lines = content.substring(0, match.index).split('\n');
                            const line = lines.length - 1; 
                            return new vscode.Location(vscode.Uri.file(catPath), new vscode.Position(line, 0));
                        }
                    } catch(e) {}
                }
                
                // Types
                const typesPath = path.join(rootPath, 'db/types/types.js');
                if (fs.existsSync(typesPath)) {
                     try {
                        const content = fs.readFileSync(typesPath, 'utf8');
                        const regex = new RegExp(`(?:["']?)\\bid\\b(?:["']?)\\s*:\\s*${id}\\b`);
                        const match = regex.exec(content);
                        if (match) {
                            const lines = content.substring(0, match.index).split('\n');
                            const line = lines.length - 1;
                            return new vscode.Location(vscode.Uri.file(typesPath), new vscode.Position(line, 0));
                        }
                    } catch(e) {}
                }
            }
            
            return null;
        }
    }));

    // 14. Product ID Hover Provider
    context.subscriptions.push(vscode.languages.registerHoverProvider(['javascript', 'json'], {
        async provideHover(document, position, token) {
            const range = document.getWordRangeAtPosition(position, /\b\d{8,12}\b/);
            if (!range) return null;
            
            const id = document.getText(range);
            
            // Resolve File Path
            let targetPath = null;
            
            // 1. Try Global Map first
            if (global.datex2ProductMap && global.datex2ProductMap[id]) {
                targetPath = global.datex2ProductMap[id];
            }
            
            // 2. Try Heuristic Search if not in map
            if (!targetPath) {
                const results = await vscode.workspace.findFiles(`db/products/**/*.${id}.js`, '**/node_modules/**', 1);
                if (results.length > 0) targetPath = results[0].fsPath;
            }

            if (!targetPath || !fs.existsSync(targetPath)) return null;

            try {
                const content = fs.readFileSync(targetPath, 'utf8');
                
                // Parse Product Data using VM for safety/robustness
                const sandbox = { module: {}, exports: {}, require: () => {} };
                vm.createContext(sandbox);
                // Wrap in try-catch for VM execution (in case of undefined vars like 'load')
                // We mock 'load' if it exists to avoid errors
                sandbox.load = () => ""; 
                
                try {
                    vm.runInContext(content, sandbox);
                } catch(e) { /* ignore runtime errors in script, we just want data structure if possible */ }
                
                const product = sandbox.module.exports || sandbox.exports || sandbox.product;
                
                if (!product) return null; // Parse failed

                // --- Extract Data ---
                // Handle '+' in slug if needed? User says internal is '+', URL might differ?
                // User said: "URL rewriting middleware that translates '+' to '➕'"
                // So dev site likely uses '➕' or encoded '+'?
                // Let's use customSlug as is for now.
                const slug = product.customSlug || "unknown-slug";
                const name = product.name || "Unknown Name";
                const seoTitle = product.seoTitle || name;
                const seoDesc = product.seoDescription || "";
                
                // --- Price Calculation ---
                let price = parseFloat(product.price) || 0;
                if (product.options && Array.isArray(product.options)) {
                    for (const opt of product.options) {
                        const defIdx = opt.defaultChoice;
                        if (typeof defIdx === 'number' && opt.choices && opt.choices[defIdx]) {
                            const choicePrice = parseFloat(opt.choices[defIdx].price) || 0;
                            price += choicePrice;
                        }
                    }
                }
                
                // --- Images ---
                const images = [];
                if (product.thumbs) {
                    // Flatten values
                    Object.values(product.thumbs).forEach(arr => {
                       if (Array.isArray(arr)) images.push(...arr);
                    });
                }
                
                // Resolve Images
                const mdImages = [];
                const workspaceRoot = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : '';
                const config = vscode.workspace.getConfiguration('datex2');
                const thumbsRegistryPath = config.get('thumbsRegistryPath');
                let thumbsRoot = thumbsRegistryPath ? path.dirname(thumbsRegistryPath) : null;

                for (let i = 0; i < Math.min(images.length, 2); i++) {
                    const imgPathRel = images[i];
                    let imgUri = null;
                    
                    // Strategy 1: Relative to product file
                    const prodDir = path.dirname(targetPath);
                    const p1 = path.join(prodDir, imgPathRel);
                    
                    if (fs.existsSync(p1)) {
                        imgUri = vscode.Uri.file(p1);
                    } else if (workspaceRoot) {
                         // Strategy 2a: Workspace Root (e.g. d:\work\DATEx2.bike\ww3\thumbs\...)
                         const pRoot = path.join(workspaceRoot, imgPathRel);
                         if (fs.existsSync(pRoot)) {
                             imgUri = vscode.Uri.file(pRoot);
                         } else {
                             // Strategy 2b: Website Dist
                             const pDist = path.join(workspaceRoot, 'website', 'dist', 'css', imgPathRel);
                             if (fs.existsSync(pDist)) imgUri = vscode.Uri.file(pDist);
                         }
                    }
                    
                    // Strategy 3: Thumbs Registry Root
                    if (!imgUri && thumbsRoot) {
                         const pReg = path.join(thumbsRoot, imgPathRel);
                         if (fs.existsSync(pReg)) imgUri = vscode.Uri.file(pReg);
                    }

                    // Fallback: Remote URL
                    // If local file not found, use https://dev.datex2.bike/
                    // imgPathRel is like "thumbs/foo.webp"
                    if (imgUri) {
                        mdImages.push(`<img src="${imgUri.toString()}" width="100" />`);
                    } else {
                        // Use remote
                        const remoteUrl = `https://dev.datex2.bike/${imgPathRel}`;
                        mdImages.push(`<img src="${remoteUrl}" width="100" />`);
                    }
                }
                
                // --- Build Markdown ---
                const md = new vscode.MarkdownString();
                md.supportHtml = true;
                md.supportThemeIcons = true;
                md.isTrusted = true;
                
                // Layout: Images on Left | Details on Right
                const imgCell = mdImages.length > 0 ? mdImages.join(' ') : 'No Image';
                const detailsCell = `**[${slug}](https://dev.datex2.bike/products/${slug})**<br/>` +
                                    `[${name}](https://my.ecwid.com/store/36380184#product:id=${id})<br/>` +
                                    `**€${price.toFixed(2)}**`;
                
                md.appendMarkdown(`| | |\n|---|---|\n| ${imgCell} | ${detailsCell} |\n\n`);

                // Resolve Logo
                let logoUri = '';
                if (workspaceRoot) {
                    const logoPath = path.join(workspaceRoot, 'website', 'logo.svg');
                    if (fs.existsSync(logoPath)) {
                        logoUri = vscode.Uri.file(logoPath).toString();
                    }
                }

                // Truncate Description (Google shows ~155-160 chars)
                let shortSeoDesc = seoDesc || "";
                if (shortSeoDesc.length > 155) {
                    shortSeoDesc = shortSeoDesc.substring(0, 155) + '...';
                }

                // Extract category path from file path (e.g., batteries-chargers/adapters)
                let categoryPath = '';
                if (targetPath && workspaceRoot) {
                    const relPath = targetPath.replace(workspaceRoot, '').replace(/\\/g, '/');
                    // Extract path between db/products/ and the product folder
                    const match = relPath.match(/db\/products\/(.+?)\/[^\/]+\/[^\/]+$/);
                    if (match && match[1]) {
                        categoryPath = match[1]; // e.g. "batteries-chargers/adapters"
                    }
                }

                // 3. SEO Preview - wrapped in max-width container
                md.appendMarkdown(`\n\n---\n\n`);
                md.appendMarkdown(`<div style="max-width:450px;">\n\n`);
                
                // Row 1: Logo + Site + URL with categories
                const logoMd = logoUri ? `![](${logoUri}|height=20)` : '🌐';
                const urlPath = categoryPath ? `products › ${categoryPath.replace(/\//g, ' › ')} › ${slug.length > 20 ? slug.substring(0,20) + '...' : slug}` : `products › ${slug.length > 25 ? slug.substring(0,25) + '...' : slug}`;
                md.appendMarkdown(`${logoMd} **DATEx2.bike** · https://datex2.bike › ${urlPath}\n\n`);
                
                // Row 2: Title as link (VS Code renders links blue)
                const fullUrl = categoryPath ? `https://datex2.bike/products/${categoryPath}/${slug}` : `https://datex2.bike/products/${slug}`;
                md.appendMarkdown(`### [${seoTitle}](${fullUrl})\n\n`);
                
                // Row 3: Description with bold first phrase
                const firstComma = shortSeoDesc.indexOf(',');
                const firstPeriod = shortSeoDesc.indexOf('.');
                const splitPoint = (firstComma > 0 && firstComma < 60) ? firstComma : (firstPeriod > 0 && firstPeriod < 80) ? firstPeriod : -1;
                
                if (splitPoint > 0) {
                    const boldPart = shortSeoDesc.substring(0, splitPoint + 1);
                    const rest = shortSeoDesc.substring(splitPoint + 1);
                    md.appendMarkdown(`**${boldPart}**${rest}\n\n`);
                } else {
                    md.appendMarkdown(`${shortSeoDesc}\n\n`);
                }
                
                // Row 4: Price line (like Google: €755.95 · In stock · etc)
                md.appendMarkdown(`**€${price.toFixed(2)}** · 🟢 In stock\n\n`);
                
                // Close container
                md.appendMarkdown(`</div>\n\n`);
                
                // 5. Open File Command
                // We use command:vscode.open to open the file URI
                const openCommandUri = vscode.Uri.parse(`command:vscode.open?${encodeURIComponent(JSON.stringify(vscode.Uri.file(targetPath)))}`);
                md.appendMarkdown(`[$(go-to-file) Open File](${openCommandUri})`);

                return new vscode.Hover(md);

            } catch (e) {
                return null;
            }
        }
    }));



} // End of activate
exports.activate = activate;
exports.deactivate = function() {};
