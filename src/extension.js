const vscode = require('vscode');
const path = require('path');

const outputChannel = vscode.window.createOutputChannel("Path Expander Debug");

function activate(context) {
    const provider = {
        provideDocumentLinks(document, token) {
            outputChannel.appendLine(`[${new Date().toISOString()}] ProvideDocumentLinks called for: ${document.fileName}`);
            const text = document.getText();
            // Regex to match file://${var}/path...
            const regex = /(file:\/\/\$\{([^}]+)\}([^"'\s]*))/g;
            const links = [];
            let match;

            while ((match = regex.exec(text))) {
                const fullMatch = match[1]; // file://${var}/...
                const varName = match[2];   // var
                const remainder = match[3]; // /path/to/file:Line#...

                outputChannel.appendLine(`Found match: ${fullMatch}`);

                // Get variable value from configuration
                const config = vscode.workspace.getConfiguration();
                const varValue = config.get(varName);

                outputChannel.appendLine(`Variable '${varName}' resolved to: '${varValue}'`);

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
                        // Only truncate if the colon is at the end part (after file extension usually)
                        // But simple approach: lastIndexOf including the number
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

                    outputChannel.appendLine(`Constructed path: ${combined}`);
                    
                    let targetUri = vscode.Uri.file(combined);
                    
                    // Add fragment for line number
                    if (line > 0) {
                        targetUri = targetUri.with({ fragment: `L${line}` });
                    }
                    
                    outputChannel.appendLine(`Final Target URI: ${targetUri.toString()}`);

                    const range = new vscode.Range(startPos, endPos);
                    const link = new vscode.DocumentLink(range, targetUri);
                    link.tooltip = `Open ${combined}`;
                    links.push(link);
                } else {
                    outputChannel.appendLine(`WARNING: Could not resolve variable '${varName}'`);
                }
            }
            outputChannel.appendLine(`Found ${links.length} links.`);
            return links;
        }
    };

    context.subscriptions.push(vscode.languages.registerDocumentLinkProvider('json', provider));

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
        
        // Detect if we are searching for a child of linkedProduct/cy
        // If source was JS linkedProduct (Scope) -> id (Prop), searchStack has both.
        // If target is JSON cy (Prop), parseLines stops at cy. 
        // We need to match the "deepest common ancestor" or leaf.
        
        // Find the "leaf-est" item in searchStack that corresponds to a line in parsedLines
        // Actually, typical logic matches full stack. 
        // We need to allow early exit if target is a Prop (string) but source was Scope (object).
        
        // Let's iterate all lines and score them.
        
        const leaf = searchStack[searchStack.length-1];
        const isValueFocus = (leaf.valStartCol && sourceCol >= leaf.valStartCol);

        for (let i = 0; i < parsedLines.length; i++) {
            const line = parsedLines[i];
            
            // Optimization: Filter by some key presence if possible
            // But strict matching is done by stack comparison.
            
            const candStack = getContextStack(parsedLines, i, blockCache);
            
            // Compare stacks
            let mismatch = false;
            let score = 0;
            // We want to match as much of searchStack as possible with candStack
            
            let sIdx = 0;
            let cIdx = 0;
            let deepestMatchSIdx = -1;
            
            while (sIdx < searchStack.length && cIdx < candStack.length) {
                const sNode = searchStack[searchStack.length - 1 - sIdx];
                const cNode = candStack[candStack.length - 1 - cIdx];
                
                // Check key match
                const sKeys = sNode.aliases || (sNode.key ? [sNode.key] : []);
                if (sNode.key === '~item') sKeys.push('~item');
                
                let keyMatch = sKeys.includes(cNode.key);
                if (!keyMatch && cNode.key && sKeys.includes(cNode.key.replace('Translated', ''))) keyMatch = true;
                
                // Handle textTranslated layer skipping
                // If sNode (search stack) has 'textTranslated' but cNode (candidate) does not match it
                // we treat 'textTranslated' as a phantom layer in the search stack and skip sNode.
                if (!keyMatch && sNode.key === 'textTranslated') {
                    sIdx++;
                    continue; 
                }

                // Reverse: If cNode has 'textTranslated' but sNode does not (source was JS without it)
                // we skip this candidate layer.
                if (!keyMatch && cNode.key === 'textTranslated') {
                    cIdx++; 
                    continue;
                }
                
                if (!keyMatch && sNode.key !== '~item' && cNode.key !== '~item') {
                    mismatch = true;
                    break;
                }
                
                deepestMatchSIdx = sIdx;
                score += 10;
                sIdx++;
                cIdx++;
            }
            
            if (!mismatch) {
                // We matched up to some point.
                // If searchStack has more items (e.g. 'id' inside 'linkedProduct')
                // and the current line is the 'cy' line (matches 'linkedProduct'),
                // we can look inside the content.
                
                let extraOffset = 0;
                const remainingStackItems = searchStack.slice(0, searchStack.length - 1 - deepestMatchSIdx).reverse();
                
                // If we have remaining items, attempt to find them in line.txt
                if (remainingStackItems.length > 0) {
                    let textToSearch = line.txt;
                    let foundAll = true;
                    let currentBase = 0;
                    
                    for (let item of remainingStackItems) {
                        if (item.key) {
                            // Flexible regex for keys: \"key\", "key", 'key', key
                            // (?:\\\"|[\"']?): optional escaped quote OR normal quote OR nothing
                            const keyPattern = '(?:\\\\\\"|["\']?)' + item.key + '(?:\\\\\\"|["\']?)\\s*:';
                            const regex = new RegExp(keyPattern);
                            const match = regex.exec(textToSearch.substring(currentBase));
                            
                            if (match) {
                                const idx = currentBase + match.index;
                                currentBase = idx + match[0].length;
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
                
                if (isValueFocus) {
                     const vMatch = line.txt.match(/:\s*(?:["']?)/);
                     if (vMatch && vMatch.index) {
                         const targetValStart = vMatch.index + vMatch[0].length + 1;
                         col = targetValStart + (leaf.valOffset || 0);
                     } else {
                         col = line.txt.length + 1;
                     }
                } else {
                     if (keyIndex >= 0) col = keyIndex + 1;
                }
                
                // Apply extra offset derived from content search
                // Only if we searched inside the value (e.g. inside cy string)
                if (extraOffset > 0) {
                    col = extraOffset + 1; // 1-based
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

        const dir = path.dirname(filePath);
        const ext = path.extname(filePath);
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
            vscode.window.showInformationMessage('No matching pair file found.');
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
        
        // --- Special Handling for 'cy' or 'linkedProduct' in source ---
        // If we are on 'cy' (JSON) or 'linkedProduct' (JS), try to find deeper context in the line value
        if (sourceStack.length > 0) {
            const last = sourceStack[sourceStack.length - 1];
            // Handle 'cy' (stringified JSON)
            if (last.key === 'cy' || (last.aliases && last.aliases.includes('cy'))) {
                const lineText = sourceLines[line - 1];
                const vMatch = lineText.match(/:\s*(?:["']?)/);
                if (vMatch && vMatch.index) {
                    const valStart = vMatch.index + vMatch[0].length;
                    const cursorRel = col - 1 - valStart;
                    if (cursorRel > 0) {
                        const valStr = lineText.substring(valStart);
                        // Search for \"key\": pattern
                        const keyRegex = /\\"(\w+)\\"\s*:/g;
                        let match;
                        let bestSubKey = null;
                        while ((match = keyRegex.exec(valStr)) !== null) {
                            if (match.index < cursorRel) {
                                bestSubKey = match[1];
                            } else {
                                break;
                            }
                        }
                        if (bestSubKey) {
                            sourceStack.push({ type: 'prop', key: bestSubKey });
                        }
                    }
                }
            } 
            // Handle 'linkedProduct' (JS object on one line)
            else if (last.key === 'linkedProduct' || (last.aliases && last.aliases.includes('linkedProduct'))) {
                 const lineText = sourceLines[line - 1];
                 const vMatch = lineText.match(/:\s*/);
                 if (vMatch && vMatch.index) {
                     const valStart = vMatch.index + vMatch[0].length;
                     const cursorRel = col - 1 - valStart;
                     if (cursorRel > 0) {
                         const valStr = lineText.substring(valStart);
                         // JSON-like JS object keys: id:, "id":, 'id':
                         const keyRegex = /(?:["']?(\w+)["']?)\s*:/g;
                         let match;
                         let bestSubKey = null;
                         while ((match = keyRegex.exec(valStr)) !== null) {
                             if (match.index < cursorRel) {
                                 bestSubKey = match[1];
                             } else {
                                 break;
                             }
                         }
                         if (bestSubKey) {
                             sourceStack.push({ type: 'prop', key: bestSubKey });
                         }
                     }
                 }
            }
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
                const ref = refs[0]; // e.g. "website/db/api/products/BCx3-220VAC/BCx3-220VAC.js:123"
                const parts = ref.split(':');
                const refPathRel = parts[0];
                const refLine = parts.length > 1 ? parseInt(parts[1]) : 1;
                
                const targetSrcPath = path.join(rootDir, refPathRel);
                
                if (fs.existsSync(targetSrcPath)) {
                    const doc = await vscode.workspace.openTextDocument(targetSrcPath);
                    const editor = await vscode.window.showTextDocument(doc);
                    const pos = new vscode.Position(refLine - 1, 0);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                    return;
                } else {
                    vscode.window.showWarningMessage(`Reference file not found: ${refPathRel}`);
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
            const wordRange = document.getWordRangeAtPosition(selection, /["']([^"']+)["']/);
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

} // End of activate

exports.activate = activate;
exports.deactivate = function() {};
