const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const outputChannel = vscode.window.createOutputChannel("Path Expander Debug");

function activate(context) {
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
                         const candidate = files.find(f => f === parentName + '.js');
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
    const provider = {
        provideDocumentLinks(document, token) {
            // outputChannel.appendLine(`[${new Date().toISOString()}] ProvideDocumentLinks called for: ${document.fileName}`);
            const text = document.getText();
            // Regex to match file://${var}/path...
            const regex = /(file:\/\/\$\{([^}]+)\}([^"'\s]*))/g;
            const links = [];
            let match;

            while ((match = regex.exec(text))) {
                const fullMatch = match[1]; // file://${var}/...
                const varName = match[2];   // var
                const remainder = match[3]; // /path/to/file:Line#...

                // outputChannel.appendLine(`Found match: ${fullMatch}`);

                // Get variable value from configuration
                const config = vscode.workspace.getConfiguration();
                const varValue = config.get(varName);

                // outputChannel.appendLine(`Variable '${varName}' resolved to: '${varValue}'`);

                if (varValue && typeof varValue === 'string') {
                    // Start index of the match
                    const startPos = document.positionAt(match.index);
                    const endPos = document.positionAt(match.index + fullMatch.length);

                    // Parse the remainder for file path and line number
                    let filePathPart = remainder;
                    let line = 0;
                    
                    // Check for Line number
                    // remainder: /file.json:123
                    const lineMatch = /:(\d+)/.exec(remainder);
                    if (lineMatch) {
                        line = parseInt(lineMatch[1]);
                        const idx = remainder.lastIndexOf(':' + lineMatch[1]);
                        if (idx !== -1) filePathPart = remainder.substring(0, idx);
                    } else {
                        // Check for hash and truncate
                        const hashIdx = remainder.indexOf('#');
                        if (hashIdx !== -1) filePathPart = remainder.substring(0, hashIdx);
                    }

                    // Construct expanded path
                    let combined = path.join(varValue, filePathPart);
                    // Normalize separators to slash
                    combined = combined.replace(/\\/g, '/');
                    
                    // If it doesn't start with slash and has drive letter (e.g. D:/...), VS Code URI expects /D:/...
                    if (!combined.startsWith('/')) {
                        combined = '/' + combined;
                    }

                    // outputChannel.appendLine(`Constructed path: ${combined}`);
                    
                    let targetUri = vscode.Uri.file(combined);
                    
                    // Add fragment for line number
                    if (line > 0) {
                        targetUri = targetUri.with({ fragment: `L${line}` });
                    }
                    
                    // outputChannel.appendLine(`Final Target URI: ${targetUri.toString()}`);

                    const range = new vscode.Range(startPos, endPos);
                    const link = new vscode.DocumentLink(range, targetUri);
                    link.tooltip = `Open ${combined}`;
                    links.push(link);
                } else {
                    // outputChannel.appendLine(`WARNING: Could not resolve variable '${varName}'`);
                }
            }
            // outputChannel.appendLine(`Found ${links.length} links.`);

            // outputChannel.appendLine(`[DATEx2] Scanning ${document.fileName} for custom links...`);
            
            // --- Custom DATEx2 Link Logic ---
            // Unified Regex to support:
            // product://SKU@Line:Col/path#html
            
            // Regex for new format
            const customRegex = /([\"'])(?:(product):([^@]+)@|(profile|category)@)([^\/]+)\/([^#\"']+?)(?:#([^\"']+))?\1/g;
            
            let customMatch;
            while ((customMatch = customRegex.exec(text))) {
                const fullMatchStr = customMatch[0];
                let quote, type, hostPart, posPart, jsonPath, htmlPath;
                
                quote = customMatch[1];
                if (customMatch[2] === 'product') {
                    // product:SLUG@... format
                    type = customMatch[2];
                    hostPart = customMatch[3];
                    posPart = customMatch[5];
                    jsonPath = customMatch[6];
                    htmlPath = customMatch[7];
                } else {
                    // profile@ or category@ format
                    type = customMatch[4];
                    hostPart = '';
                    posPart = customMatch[5];
                    jsonPath = customMatch[6];
                    htmlPath = customMatch[7];
                }
                // Debug matching
                // outputChannel.appendLine(`[DATEx2] Match: ${fullMatchStr}`);
                // outputChannel.appendLine(`[DATEx2] Type: ${type}, Host: ${hostPart}, Pos: ${posPart}, Path: ${jsonPath}`);

                let targetPath = '';
                let targetLine = 1;
                let targetCol = 1;
                
                // Parse Position
                const posParts = posPart.split(':');
                if (posParts.length > 0) targetLine = parseInt(posParts[0]);
                if (posParts.length > 1) targetCol = parseInt(posParts[1]);

                if (type === 'profile') {
                    // profile@LINE:COL/path - opens db/profile/profile.js at line/col
                    targetPath = 'db/profile/profile.js';
                    if (htmlPath) {
                         targetPath = `db/profile/${htmlPath}`;
                         targetLine = 1; 
                         targetCol = 1;
                    }
                } else if (type === 'category') {
                    // category@LINE:COL/path - opens db/categories/categories.js at line/col
                    targetPath = 'db/categories/categories.js';
                    if (htmlPath) {
                        targetPath = `db/categories/${htmlPath}`;
                        targetLine = 1;
                        targetCol = 1;
                    }
                } else if (type === 'product') {
                    const codeOrSlug = hostPart;
                    if (codeOrSlug) {
                        if (htmlPath) {
                             targetPath = `db/products/${codeOrSlug}/${htmlPath}`;
                             targetLine = 1; 
                             targetCol = 1;
                        } else {
                            targetPath = `db/products/${codeOrSlug}/${codeOrSlug}.js`;
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
                         
                         const matchIndex = customMatch.index; 
                         const startPos = document.positionAt(matchIndex + 1); 
                         const endPos = document.positionAt(matchIndex + fullMatchStr.length - 1);
                         
                         const link = new vscode.DocumentLink(new vscode.Range(startPos, endPos), targetUri);
                         link.tooltip = `Open ${targetPath} at line ${targetLine}:${targetCol}`;
                         links.push(link);
                     }
                }
            }

            // --- Data URI Support (Ctrl+Click) ---
            // Support: quoted "data:..." or 'data:...' AND unquoted inside url(data:...)
            const dataUriRegex = /(["'])(data:[^"'\s]*)\1|url\((data:[^)"'\s]*)\)/g;
            let dataMatch;
            while ((dataMatch = dataUriRegex.exec(text))) {
                 const isUnquoted = !!dataMatch[3];
                 const fullUri = isUnquoted ? dataMatch[3] : dataMatch[2];
                 
                 let start, end;
                 if (isUnquoted) {
                     start = dataMatch.index + 4; // url(
                     end = start + fullUri.length;
                 } else {
                     start = dataMatch.index + 1; // " or '
                     end = start + fullUri.length;
                 }

                 const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
                 
                 const args = [fullUri];
                 const commandUri = vscode.Uri.parse(`command:datex2.openDataUri?${encodeURIComponent(JSON.stringify(args))}`);
                 
                 const link = new vscode.DocumentLink(range, commandUri);
                 link.tooltip = "Open Data URI in Browser";
                 links.push(link);
            }

            return links;
        }
    };

    // Command to open Data URI
    context.subscriptions.push(vscode.commands.registerCommand('datex2.openDataUri', async (uriString) => {
        try {
            // Create a temporary HTML file to display the image
            // This avoids issues with OS command length limits or protocol handling for data: URIs
            const tmpDir = require('os').tmpdir();
            const tmpFile = path.join(tmpDir, 'datex2_image_preview.html');
            
            const htmlContent = `
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Image Preview</title>
                    <style>
                        body { 
                            background-color: #1e1e1e; 
                            display: flex; 
                            justify-content: center; 
                            align-items: center; 
                            height: 100vh; 
                            margin: 0; 
                        }
                        img { 
                            max-width: 90%; 
                            max-height: 90%; 
                            box-shadow: 0 0 20px rgba(0,0,0,0.5); 
                        }
                    </style>
                </head>
                <body>
                    <img src="${uriString}" />
                </body>
                </html>
            `;
            
            fs.writeFileSync(tmpFile, htmlContent, 'utf8');
            await vscode.env.openExternal(vscode.Uri.file(tmpFile));
            
        } catch (e) {
            vscode.window.showErrorMessage('Failed to open data URI: ' + e.message);
        }
    }));

    // --- Image Preview Hover ---
    context.subscriptions.push(vscode.languages.registerHoverProvider(['json', 'javascript', 'html', 'css', 'scss', 'less'], {
        provideHover(document, position, token) {
            const line = document.lineAt(position.line);
            const text = line.text;
            // Regex for quoted OR url(...) unquoted
            const dataUriRegex = /(["'])(data:image\/[^"'\s]*)\1|url\((data:image\/[^)"'\s]*)\)/g;
            let match;
            while ((match = dataUriRegex.exec(text))) {
                const isUnquoted = !!match[3];
                const dataUri = isUnquoted ? match[3] : match[2];
                
                let startOfData, endOfData;
                if (isUnquoted) {
                     startOfData = match.index + 4;
                     endOfData = startOfData + dataUri.length;
                } else {
                     startOfData = match.index + 1;
                     endOfData = startOfData + dataUri.length;
                }

                if (position.character >= startOfData && position.character <= endOfData) {
                    const md = new vscode.MarkdownString();
                    md.supportHtml = true;
                    md.isTrusted = true;
                    md.appendMarkdown(`![Image Preview](${dataUri})`);
                    return new vscode.Hover(md);
                }
            }
            return null;
        }
    }));

    // Register Link Provider with CSS support
    context.subscriptions.push(vscode.languages.registerDocumentLinkProvider(['json', 'javascript', 'html', 'css', 'scss', 'less'], provider));

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
            try {
                const files = fs.readdirSync(dir);
                const target = files.find(f => f.startsWith(basement + '.') && f.match(/\.\d+\.json$/));
                if (target) targetPath = path.join(dir, target);
            } catch (e) {}
        } else if (ext === '.json') {
            const baseParts = basement.split('.');
            if (baseParts.length > 1 && /^\d+$/.test(baseParts[baseParts.length - 1])) {
                baseParts.pop(); 
            }
            const candidateName = baseParts.join('.') + '.js';
            const candPath = path.join(dir, candidateName);
            if (fs.existsSync(candPath)) targetPath = candPath;
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

} // End of activate

exports.activate = activate;
exports.deactivate = function() {};
