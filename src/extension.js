const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const imageSize = require('image-size');
const seoPreview = require('./seoPreview');
const os = require('os');
const crypto = require('crypto');

const outputChannel = vscode.window.createOutputChannel("Path Expander Debug");

function activate(context) {
    seoPreview.activate(context);
    // --- Translation Status Bar Logic ---
    const missingItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    const percentItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    context.subscriptions.push(missingItem);
    context.subscriptions.push(percentItem);

    missingItem.command = 'datex2.showMissingTranslations';
    percentItem.command = 'datex2.showMissingTranslations';
    missingItem.tooltip = "Click to go to next missing translation";
    percentItem.tooltip = "Translation progress";

    missingItem.text = "$(sync~spin) ...";
    missingItem.show();
    percentItem.text = "%";
    percentItem.show();

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

    async function updateStatusBar() {
        const productFiles = await vscode.workspace.findFiles('db/products/**/*.js', '**/node_modules/**');
        let total = 0;
        let missing = 0;
        let cacheMissing = 0;
        let cacheTotal = 0;

        for (const file of productFiles) {
            try {
                const content = fs.readFileSync(file.fsPath, 'utf8');
                
                // Count Totals (Candidates)
                const baseKeys = ['name', 'seoTitle', 'seoDescription', 'description', 'text', 'value'];
                const keysPatternStr = `(?:\\w*Translated)|${baseKeys.join('|')}`;
                const keyPattern = new RegExp(`(?:^|\\s|,|{)(?:["']?)(${keysPatternStr})(?:["']?)\\s*:\\s*(["'])((?:(?!\\2)[^\\\\]|\\\\.)*?)\\2`, 'g');
                const loadPattern = /load\(\s*(["'])((?:(?!\1)[^\\]|\\.)*?)\1\s*\)/g;
                
                let m;
                while ((m = keyPattern.exec(content)) !== null) {
                    if(m[3].length > 0) total++;
                }
                while ((m = loadPattern.exec(content)) !== null) {
                     if(m[2].length > 0) total++;
                }

                // Count Missing
                const missingEntries = getMissingEntries(content);
                missing += missingEntries.length;

            } catch (e) { console.error(e); }
        }

        // Check cache file
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
                    cacheTotal = keys.length;
                    
                    let mCount = 0;
                    for (const k of keys) {
                        if (!k.endsWith(' ')) {
                            mCount++;
                        }
                        
                        const v = cacheJson[k];
                        if (v && typeof v === 'object') {
                            for (const lang of Object.keys(v)) {
                                if (lang === 'cy' || lang === 'refs') continue;
                                const t = v[lang];
                                if (typeof t === 'string' && !t.endsWith(' ')) {
                                    mCount++;
                                }
                            }
                        }
                    }
                    cacheMissing = mCount;
                }
            }
        } catch (e) { console.error('Error reading translation cache:', e); }

        const combinedTotal = total + cacheTotal;
        const combinedMissing = missing + cacheMissing;
        const percent = combinedTotal > 0 ? Math.round(((combinedTotal - combinedMissing) / combinedTotal) * 100) : 100;
        
        missingItem.text = `${combinedMissing} (${percent}%)`; 
        missingItem.color = combinedMissing > 0 ? '#FFFF00' : '#FFFFFF';
        missingItem.tooltip = `Products: ${missing} missing, Cache: ${cacheMissing} missing`;
        missingItem.show();
        percentItem.hide();
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
                        obj[lang] = (lang === 'en') ? enText : "";
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
                        if (htmlPath) {
                             targetPath = `db/products/${codeOrSlug}/${htmlPath}`;
                             targetLine = 1; targetCol = 1;
                        } else {
                            // Link to Product JS: Discover file (slug.ID.js or slug.js)
                            const rootPath = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : '';
                            if (rootPath) {
                                const productDir = path.join(rootPath, 'db/products', codeOrSlug);
                                if (fs.existsSync(productDir)) {
                                    const files = fs.readdirSync(productDir);
                                    const targetFile = files.find(f => f.match(new RegExp(`^${codeOrSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.js$`))) || `${codeOrSlug}.js`;
                                    targetPath = `db/products/${codeOrSlug}/${targetFile}`;
                                    // Verify existence?
                                    if (!fs.existsSync(path.join(productDir, targetFile))) targetPath = null;
                                } else {
                                    targetPath = null;
                                }
                            }
                        }
                    }
                }

                if (targetPath) {
                     const rootPath = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : '';
                     if (rootPath) {
                         const absPath = path.join(rootPath, targetPath);
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
                 // Handle URIs passed as JSON objects (UriComponents) which might happen if args are serialized Uri objects
                 if (filePath.scheme) {
                     targetUri = vscode.Uri.from(filePath);
                 } else {
                     // Fallback, assume string path if possible or re-wrap
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
    context.subscriptions.push(vscode.commands.registerCommand('datex2.toggleTranslationFile', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const document = editor.document;
        const filePath = document.fileName;
        const selection = editor.selection.active;
        const lineIdx = selection.line;
        const colIdx = selection.character;
        const currentLineText = document.lineAt(lineIdx).text;

        const cacheFilePath = 'website/db/translations/translations.ai.cache.json'; 
        
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
            // Parse current block to find "refs"
            const lines = document.getText().split(/\r?\n/);
            // 1. Find the start of the current object block
            // Simple heuristic used here: look backwards for a line ending in '{' that isn't nested too deep or is a key
            // A better way with existing helpers: parse lines, get stack.
            
            const parsed = parseLines(lines);
            const stack = getContextStack(parsed, lineIdx, new Map());
            
            // In the cache file, structure is usually: "Key": { "lang": "...", "refs": ["path:line"] }
            // So we look for the 'refs' property in the current block, or if we are on a key, the refs of that key.
            
            let refs = [];
            
            // Iterate lines forward from current block start to find "refs"
            // Find the index of the key definition for the current block
            let blockStartIdx = -1;
            
            // If we are inside the object, the stack[0] should be the Key of the translation item
            // stack[0] -> type: 'scope', key: 'TheTranslationKey'
            
            if (stack.length > 0) {
                const itemKey = stack[0].key;
                
                // Scan content of this item for "refs"
                // We need to find where this item starts in the file. 
                // The stack creation logic went backwards to find parents.
                // Let's search forward from the line where the item key was defined.
                // Re-parsing mostly to find the line number of the key
                
                // Optimization: Just search in the local vicinity of the cursor for "refs": [ ... ]
                // This is a "hacky" but fast search.
                
                // Expand search window: 50 lines up and down
                let startSearch = Math.max(0, lineIdx - 50);
                let endSearch = Math.min(lines.length, lineIdx + 50);
                
                // Find "refs" array
                for (let i = startSearch; i < endSearch; i++) {
                    const l = lines[i];
                    if (l.includes('"refs":')) {
                        // Found refs start. Parse the JSON array roughly.
                        // Assuming format: "refs": [ "path:line", ... ]
                        // It might span multiple lines.
                        let j = i;
                        let jsonStr = "";
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
                        if (refs.length > 0) break;
                    }
                }
            }

            if (refs.length > 0) {
                // Take the first ref
                const ref = refs[0]; 
                
                let targetSrcPath = null;
                let refLine = 1;
                let refCol = 1;

                if (ref.includes('@')) {
                    // New Format: product:host@line:col/path#html or profile@line:col/path
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
                             targetSrcPath = path.join(rootDir, `db/products/${host}/${host}.js`);
                        } else if (type === 'category') {
                             targetSrcPath = path.join(rootDir, 'db/categories/categories.js');
                        } else if (type === 'profile') {
                             targetSrcPath = path.join(rootDir, 'db/profile/profile.js');
                        }
                    }
                } else if (ref.includes('://')) {
                    // URL Format (Legacy): type://host@line:col/path#html
                    const regex = /(product|category|profile):\/\/([^@]*)@([^/]+)\/([^#]+)(?:#.*)?/;
                    // Legacy Format: path:line
                    const parts = ref.split(':');
                    const refPathRel = parts[0];
                    refLine = parts.length > 1 ? parseInt(parts[1]) : 1;
                    targetSrcPath = path.join(rootDir, refPathRel);
                }
                
                if (targetSrcPath && fs.existsSync(targetSrcPath)) {
                    const doc = await vscode.workspace.openTextDocument(targetSrcPath);
                    const editor = await vscode.window.showTextDocument(doc);
                    const pos = new vscode.Position(refLine - 1, refCol - 1);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                    return;
                } else {
                    vscode.window.showWarningMessage(`Reference file not found or invalid format: ${ref}`);
                }
            } else {
                vscode.window.showInformationMessage("No references found for this translation entry.");
            }

        } else {
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
            const searchRegex = new RegExp(`^\\s*"${escapedSearch}"\\s*:`);
            
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
                const pos = new vscode.Position(foundLine, 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            } else {
                vscode.window.showInformationMessage(`Translation entry "${searchText}" not found in cache.`);
            }
        }
    }));

    // --- Cursor Preservation for External Reloads ---
    const lastSelections = new Map(); // fileName (lowercase) -> Position

    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(e => {
        if (e.selections.length > 0 && e.textEditor.document.fileName.includes('products') && e.textEditor.document.fileName.endsWith('.js')) {
            lastSelections.set(e.textEditor.document.fileName.toLowerCase(), e.selections[0].active);
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
    // }));


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


} // End of activate
exports.activate = activate;
exports.deactivate = function() {};
