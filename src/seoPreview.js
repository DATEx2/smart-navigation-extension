const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

class SeoPreviewPanel {
    static currentPanel = undefined;
    static viewType = 'seoPreview';

    static createOrShow(extensionUri) {
        try {
            const column = vscode.window.activeTextEditor
                ? vscode.ViewColumn.Beside
                : undefined;

            if (SeoPreviewPanel.currentPanel) {
                if (SeoPreviewPanel.currentPanel._panel) {
                    SeoPreviewPanel.currentPanel._panel.reveal(column);
                } else {
                    SeoPreviewPanel.currentPanel = undefined;
                }
                if (SeoPreviewPanel.currentPanel) return;
            }

            // Determine resource roots
            const resourceRoots = [vscode.Uri.joinPath(extensionUri, 'assets')];
            if (vscode.workspace.workspaceFolders) {
                resourceRoots.push(...vscode.workspace.workspaceFolders.map(f => f.uri));
            }
            
            // Add current file's ancestor directories
            if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document) {
                try {
                    const currentDir = path.dirname(vscode.window.activeTextEditor.document.fileName);
                    resourceRoots.push(vscode.Uri.file(currentDir));
                    let parent = currentDir;
                    for(let i=0; i<3; i++) {
                        parent = path.dirname(parent);
                        resourceRoots.push(vscode.Uri.file(parent));
                    }
                } catch (e) { console.error("Error setting paths", e); }
            }

            const panel = vscode.window.createWebviewPanel(
                SeoPreviewPanel.viewType,
                'SEO Live Preview',
                column || vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    localResourceRoots: resourceRoots,
                    retainContextWhenHidden: true
                }
            );

            SeoPreviewPanel.currentPanel = new SeoPreviewPanel(panel, extensionUri);
        } catch (e) {
            vscode.window.showErrorMessage('Error opening SEO Preview: ' + e.message);
        }
    }

    static revive(panel, extensionUri) {
        SeoPreviewPanel.currentPanel = new SeoPreviewPanel(panel, extensionUri);
    }

    constructor(panel, extensionUri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._disposables = [];
        this._lastEditor = vscode.window.activeTextEditor;
        this._currentProductData = null; 

        // Set HTML content immediately
        try {
            this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
        } catch (e) {
            vscode.window.showErrorMessage('Error setting WebView HTML: ' + e.message);
        }
        
        // Initial update
        setTimeout(() => this._update(), 100); 

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.onDidChangeViewState(
            e => {
                if (this._panel.visible) {
                    this._update();
                }
            },
            null,
            this._disposables
        );

        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'updateField':
                        this._updateDocument(message.field, message.value);
                        return;
                    case 'requestUpdate':
                        this._update();
                        return;
                }
            },
            null,
            this._disposables
        );

        // Watch JS Document Changes
        vscode.workspace.onDidChangeTextDocument(e => {
            if (this._lastEditor && e.document.uri.toString() === this._lastEditor.document.uri.toString()) {
                this._update(true);
            } 
            else if (this._currentProductData && this._currentProductData.descriptionPath) {
                if (e.document.uri.fsPath === this._currentProductData.descriptionPath) {
                    this._update(true);
                }
            }
        }, null, this._disposables);

        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                if (editor.document.languageId === 'javascript' || editor.document.languageId === 'json') {
                     this._lastEditor = editor;
                     this._update();
                }
            }
        }, null, this._disposables);
    }

    dispose() {
        SeoPreviewPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables && this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    async _update(isFileChange = false) {
        try {
            let editor = vscode.window.activeTextEditor;
            if (!editor) {
                 if (this._lastEditor) editor = this._lastEditor;
                 else {
                     this._panel.webview.postMessage({ command: 'clear' });
                     return;
                 }
            }
            
            let masterDoc = null;
            let masterText = '';
            let descriptionFileOverride = null;

            if (editor.document.languageId === 'javascript' || editor.document.languageId === 'json') {
                masterDoc = editor.document;
                masterText = masterDoc.getText();
                this._lastEditor = editor; 
            } else if (editor.document.languageId === 'html') {
                const dir = path.dirname(editor.document.fileName);
                let candidates = [];
                try {
                    if(fs.existsSync(dir)) {
                        candidates = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.endsWith('thumbs.js'));
                    }
                } catch(e) {}

                let foundJsPath = null;
                if (candidates.length > 0) {
                    const folderName = path.basename(dir);
                    const exactMatch = candidates.find(f => f === folderName + '.js');
                    foundJsPath = exactMatch ? path.join(dir, exactMatch) : path.join(dir, candidates[0]);
                }
                
                if (foundJsPath && fs.existsSync(foundJsPath)) {
                    try {
                         masterText = fs.readFileSync(foundJsPath, 'utf8');
                         this._masterFilePath = foundJsPath;
                         descriptionFileOverride = editor.document.fileName;
                    } catch(e) { }
                }
            }

            if (!masterText && this._lastEditor && this._lastEditor.document.languageId === 'javascript') {
                 masterDoc = this._lastEditor.document;
                 masterText = masterDoc.getText();
            }

            if (masterText) {
                 const data = await this._parseSeoData(masterText, masterDoc ? masterDoc.fileName : this._masterFilePath, descriptionFileOverride);
                 this._currentProductData = data; 
                 this._panel.webview.postMessage({ command: 'update', data: data });
            } else {
                 this._panel.webview.postMessage({ command: 'clear' });
            }
        } catch (e) {
            console.error(e);
        }
    }

    async _parseSeoData(text, fileName, descriptionFileOverride = null) {
        try {
            const getValue = (key) => {
                const regex = new RegExp(`(?:^|\\s|,|{)(?:["']?)(${key})(?:["']?)\\s*:\\s*(["'\`])((?:(?!\\2)[^\\\\]|\\\\.)*?)\\2`, 'i');
                const match = text.match(regex);
                if (match) {
                     try {
                         return match[3].replace(/\\(["'\\])/g, '$1').replace(/\\n/g, '\n');
                     } catch(e) { return match[3]; }
                }
                return '';
            };

            const seoTitle = getValue('seoTitle');
            const name = getValue('name');
            const seoDescription = getValue('seoDescription');

            let cssLinks = [];
            let debugCssPaths = [];
            
            // Relaxed regex: just look for css: [...] property
            // We use [\s\S]*? to capture multiline content non-greedily until the closing ]
            const cssArrayRegex = /(?:["']?)css(?:["']?)\s*:\s*(\[[\s\S]*?\])/i;
            const cssStringRegex = /(?:["']?)css(?:["']?)\s*:\s*(["'])(.*?)\1/i;
            
            const arrayMatch = text.match(cssArrayRegex);
            const stringMatch = text.match(cssStringRegex);

            if (arrayMatch) {
                const rawArrayBody = arrayMatch[1]; 
                // debug
                debugCssPaths.push({ info: "Found Raw CSS Array", content: rawArrayBody });

                const linkMatches = rawArrayBody.matchAll(/(["'])(.*?)\1/g);
                for (const match of linkMatches) {
                     cssLinks.push(match[2]);
                }
            } else if (stringMatch) {
                const rawString = stringMatch[2];
                debugCssPaths.push({ info: "Found Raw CSS String", content: rawString });
                cssLinks.push(rawString);
            } else {
                debugCssPaths.push({ info: "No CSS regex match found in text", length: text.length });
            }
            
            const resolvedCssLinks = [];
            
            // Inject Global/Ecwid CSS
            // FORCE DIST: Use dist/css/DATEx2.bike.css instead of src
            // Check if already in cssLinks (unlikely but good safety)
            if (!cssLinks.some(l => l.includes('DATEx2.bike.css'))) {
                cssLinks.unshift('website/dist/css/DATEx2.bike.css');
            }
            // Inject documentStyle.css BEFORE DATEx2.bike.css
            if (!cssLinks.some(l => l.includes('documentStyle.css'))) {
                cssLinks.unshift('website/src/css/documentStyle.css');
            }

            if (fileName && this._panel) {
                const dir = path.dirname(fileName);
                const webview = this._panel.webview;
                const importedPaths = new Set();
                
                // 1. Inject Global Ecwid/DATEx2 CSS first -- REMOVED (Handled by cssLinks.unshift above)
                /* 
                try {
                     // Legacy block removed to avoid loading src/css/DATEx2.css
                } catch(e) {} 
                */

                // 2. Inject Product Specific CSS
                // Use for...of to allow await inside loop
                for (const link of cssLinks) {
                    try {
                        let absPath = path.join(dir, link);
                        let exists = fs.existsSync(absPath);
                        let strategy = "relative";

                        // FORCE DIST HEURISTIC: Check website/dist/css first for known patterns (thumbs)
                        if (link.toLowerCase().includes('thumbs/')) {
                            // Normalize link separators for path.join
                            const cleanLink = link.replace(/^\.\//, '').replace(/^\//, '').split('/').join(path.sep);
                            
                            if (vscode.workspace.workspaceFolders) {
                                for (const folder of vscode.workspace.workspaceFolders) {
                                    // Try matching website/dist/css structure
                                    const distAttempt = path.join(folder.uri.fsPath, 'website', 'dist', 'css', cleanLink);
                                    
                                    // console.log("Checking Dist: " + distAttempt);
                                    if (fs.existsSync(distAttempt)) {
                                        absPath = distAttempt;
                                        exists = true;
                                        strategy = "force-dist-thumbs";
                                        break;
                                    }
                                    
                                    // Try Capitalized 'Thumbs' if link starts with 'thumbs' (case insensitive check usually handled by FS on windows, but for strictness/linux)
                                    // Note: On Windows fs.existsSync is case insensitive, but let's be safe.
                                    if (cleanLink.toLowerCase().startsWith('thumbs' + path.sep)) {
                                         // specific check for Thumbs capitalization
                                         const capLink = 'Thumbs' + cleanLink.substring(6);
                                         const distAttemptCap = path.join(folder.uri.fsPath, 'website', 'dist', 'css', capLink);
                                         if (fs.existsSync(distAttemptCap)) {
                                             absPath = distAttemptCap;
                                             exists = true;
                                             strategy = "force-dist-Thumbs-cap";
                                             break;
                                         }
                                    }
                                }
                            }
                        }

                        // ... (resolution logic omitted for brevity, it's inside the big block I'm keeping or recreating?) ...
                        // Wait, I need to preserve the resolution logic. I should just wrap the push.
                        
                        // RE-IMPLEMENT RESOLUTION LOGIC to apply set check at the end.
                        
                        // If not found relative to file, try relative to workspace root(s)
                        if (!exists && vscode.workspace.workspaceFolders) {
                             // ... existing logic ...
                             for (const folder of vscode.workspace.workspaceFolders) {
                                  const cleanLink = link.replace(/^\.\//, '').replace(/^\//, ''); 
                                  const rootPath = path.join(folder.uri.fsPath, link);
                                  // try raw link relative to root
                                  if (fs.existsSync(rootPath)) {
                                      absPath = rootPath;
                                      exists = true;
                                      strategy = "workspace-root";
                                      break;
                                  }
                                  
                                  const rootClean = path.join(folder.uri.fsPath, cleanLink);
                                  if (fs.existsSync(rootClean)) {
                                      absPath = rootClean;
                                      exists = true;
                                      strategy = "workspace-root-clean";
                                      break;
                                  }
                             }
                        }

                        // Specific Heuristic for "thumbs" paths:
                        if (!exists && (link.includes('thumbs') || link.includes('css'))) {
                             let currentScanDir = dir;
                             const cleanLink = link.replace(/^\.\//, '').replace(/^\/thumbs\//, 'thumbs/'); 
                             
                             for(let i=0; i<8; i++) {
                                 const candidate = path.join(currentScanDir, cleanLink); 
                                 if (fs.existsSync(candidate)) {
                                     absPath = candidate;
                                     exists = true;
                                     strategy = "thumbs-walk-up-found";
                                     break;
                                 }
                                 const nextDir = path.dirname(currentScanDir);
                                 if (nextDir === currentScanDir) break; 
                                 currentScanDir = nextDir;
                             }
                        }

                        // GLOBAL FALLBACK: Workspace Search
                        if (!exists) {
                            const cleanLink = link.replace(/^\.\//, '').replace(/^\//, ''); 
                            const filename = path.basename(cleanLink);
                            const globPattern = '**/' + cleanLink;
                            
                            const foundFiles = await vscode.workspace.findFiles(globPattern, '**/node_modules/**', 1);
                            if (foundFiles && foundFiles.length > 0) {
                                absPath = foundFiles[0].fsPath;
                                exists = true;
                                strategy = "workspace-glob-search";
                            } else {
                                const globFilename = '**/' + filename;
                                const foundFiles2 = await vscode.workspace.findFiles(globFilename, '**/node_modules/**', 1);
                                if (foundFiles2 && foundFiles2.length > 0) {
                                    absPath = foundFiles2[0].fsPath;
                                    exists = true;
                                    strategy = "workspace-filename-search";
                                }
                            }
                        }

                        // FINAL SAFETY: Redirect 'src/css' to 'dist/css' if possible
                        if (exists && (absPath.includes('src' + path.sep + 'css') || absPath.includes('src/css'))) {
                             // Attempt replace
                             const distPath = absPath.replace('src' + path.sep + 'css', 'dist' + path.sep + 'css')
                                                     .replace('src/css', 'dist/css');
                             if (fs.existsSync(distPath)) {
                                 absPath = distPath;
                                 strategy = strategy + " -> redirect-to-dist";
                             }
                        }

                        // DEDUP CHECK
                        const lowerAbsPath = absPath.toLowerCase();
                        if (importedPaths.has(lowerAbsPath)) {
                            debugCssPaths.push({
                                original: link,
                                resolved: absPath,
                                info: "Skipped duplicate CSS (path)"
                            });
                            continue; 
                        }
                        
                        // Deduplicate by Filename (if same file name already loaded, skip)
                        // This prevents BCx3.css from src and dist both being loaded, or if global loaded it?
                        // Actually, we allow same filename if different path, usually. 
                        // But for "BCx3.css" specifically, we probably only want one.
                        // Let's rely on path dedup for now, since we redirect to dist.

                        if (exists) {
                            importedPaths.add(lowerAbsPath);
                        }

                        const uri = vscode.Uri.file(absPath);
                        resolvedCssLinks.push(webview.asWebviewUri(uri).toString());
                        
                        debugCssPaths.push({
                            original: link,
                            resolved: absPath,
                            exists: exists,
                            strategy: strategy
                        });
                    } catch(e) {
                         debugCssPaths.push({ original: link, error: e.message });
                    }
                }
            }
            
            let description = '';
            let descriptionPath = null;
            let descriptionMode = 'inline';

            const loadRegex = /description\s*:\s*load\(\s*(["'])(.+?)\1\s*\)/i;
            const loadMatch = text.match(loadRegex);

            if (descriptionFileOverride) {
                descriptionMode = 'file';
                descriptionPath = descriptionFileOverride;
                 if (fs.existsSync(descriptionPath)) {
                    try {
                        description = fs.readFileSync(descriptionPath, 'utf8');
                    } catch (e) {
                        description = `(Error reading file: ${e.message})`;
                    }
                }
            } else if (loadMatch) {
                const relPath = loadMatch[2].trim(); 
                const dir = path.dirname(fileName || '.');
                const absPath = path.join(dir, relPath);
                descriptionMode = 'file';
                descriptionPath = absPath;
                
                if (fs.existsSync(absPath)) {
                    try {
                        description = fs.readFileSync(absPath, 'utf8');
                    } catch (e) {
                        description = `(Error reading file: ${e.message})`;
                    }
                } else {
                    description = `(File not found: ${relPath})`;
                }
            } else {
                description = getValue('description');
            }

            let title = seoTitle || name || 'Title Missing';
            let metaDesc = seoDescription || 'Description Missing'; 

            let url = 'https://datex2.bike/products/...';
            if (fileName) {
                 const parts = fileName.split(/[\\/]/);
                 const fname = parts.pop().replace(/\.js$/, '');
                 url = `https://datex2.bike/products/${fname}`;
            }

            return {
                title: title,
                description: metaDesc,
                url: url,
                productDescription: description,
                descriptionMode: descriptionMode,
                descriptionPath: descriptionPath,
                hasSeoTitle: !!seoTitle,
                hasSeoDescription: !!seoDescription,
                masterFilePath: fileName,
                cssLinks: resolvedCssLinks,
                debugCssPaths: debugCssPaths
            };
        } catch(e) {
            console.error("Parse Error", e);
            return {};
        }
    }

    async _updateDocument(field, value) {
        const data = this._currentProductData;
        if (!data) return;

        if (field === 'productDescription' && data.descriptionMode === 'file' && data.descriptionPath) {
             try {
                 fs.writeFileSync(data.descriptionPath, value, 'utf8');
             } catch (e) {
                 vscode.window.showErrorMessage('Failed to write description file: ' + e.message);
             }
             return;
        }

        const masterPath = data.masterFilePath;
        if (!masterPath) return;

        const openEditor = vscode.window.visibleTextEditors.find(e => e.document.fileName === masterPath);
        if (openEditor) {
            await this._applyEditToEditor(openEditor, field, value);
        } else {
            const doc = await vscode.workspace.openTextDocument(masterPath);
            await this._applyEditToDocument(doc, field, value);
        }
    }

    async _applyEditToDocument(doc, field, value) {
         const text = doc.getText();
         const edit = new vscode.WorkspaceEdit();
         const keyMap = {
            'title': 'seoTitle',
            'description': 'seoDescription',
            'productDescription': 'description'
        };
        const targetKey = keyMap[field];
        if (!targetKey) return;

        const regex = new RegExp(`((?:^|\\s|,|{)(?:["']?)(${targetKey})(?:["']?)\\s*:\\s*(["'\`]))((?:(?!\\3)[^\\\\]|\\\\.)*?)(\\3)`, 'g');
        const match = regex.exec(text);
        
        let finalValue = value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"'); 
        
        if (match) {
             const quote = match[3];
             if (quote === '`') {
                finalValue = value.replace(/`/g, '\\`').replace(/\$/g, '\\$');
            } else if (quote === "'") {
                finalValue = value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/'/g, "\\'");
            }
            
            const startOffset = match.index + match[1].length;
            const endOffset = startOffset + match[4].length;
            const range = new vscode.Range(doc.positionAt(startOffset), doc.positionAt(endOffset));
            
            if (doc.getText(range) !== finalValue) {
                edit.replace(doc.uri, range, finalValue);
                await vscode.workspace.applyEdit(edit);
                await doc.save(); 
            }
        } else {
             const nameRegex = /((?:^|\\s|,|{)(?:["']?)name(?:["']?)\\s*:\\s*(["'\`])((?:(?!\\2)[^\\\\]|\\\\.)*?)\2)/;
             const nameMatch = text.match(nameRegex);
             if (nameMatch) {
                const insertPos = doc.positionAt(nameMatch.index + nameMatch[0].length);
                edit.insert(doc.uri, insertPos, `,\n    ${targetKey}: "${finalValue}"`);
                await vscode.workspace.applyEdit(edit);
                await doc.save();
            }
        }
    }

    async _applyEditToEditor(editor, field, value) {
         return this._applyEditToDocument(editor.document, field, value);
    }

    _getHtmlForWebview(webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>
        body {
            font-family: Arial, sans-serif;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 20px;
            overflow-x: hidden;
        }
        .container {
            max-width: 650px;
            margin: 0 auto;
        }
        h2 { margin-bottom: 20px; font-weight: normal; font-size: 1.5rem; }
        
        .preview-box {
            background: #fff;
            padding: 16px;
            border-radius: 8px;
            box-shadow: 0 1px 2px rgba(0,0,0,0.1);
            margin-bottom: 30px;
        }
        body.vscode-dark .preview-box { background: #fff; color: #222; }

        .google-res { font-family: arial, sans-serif; line-height: 1.58; word-wrap: break-word; }
        .cite { display: block; color: #202124; font-size: 14px; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-bottom: 2px; }
        .g-title { display: inline-block; color: #1a0dab; font-size: 20px; line-height: 1.3; font-weight: 400; text-decoration: none; cursor: pointer; margin-bottom: 3px; }
        .g-title:hover { text-decoration: underline; }
        .g-desc { display: block; color: #4d5156; line-height: 1.58; font-size: 14px; }
        
        .editor-section { margin-top: 20px; }
        .input-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 6px; font-weight: 600; font-size: 0.9rem; }
        
        input, textarea {
            width: 100%; padding: 10px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-editor-font-family);
            font-size: 13px; border-radius: 2px; box-sizing: border-box; 
        }
        input:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
        textarea { resize: vertical; min-height: 80px; }
        
        /* WYSIWYG Editor Style */
        .wysiwyg-editor {
            min-height: 200px;
            border: 1px solid var(--vscode-input-border);
            background: #fff; 
            color: #222; 
            padding: 10px;
            overflow: auto;
            border-radius: 2px;
            white-space: normal;
        }
        .wysiwyg-editor:focus { outline: 1px solid var(--vscode-focusBorder); }
        
        /* Progress Bar */
        .progress-bar { height: 6px; background: #e0e0e0; border-radius: 3px; margin-top: 6px; position: relative; overflow: hidden; }
        .progress-fill { height: 100%; background: #4caf50; width: 0%; transition: width 0.3s ease; }
        .progress-fill.warning { background: #ff9800; }
        .progress-fill.danger { background: #f44336; }
        
        .meta-info { font-size: 0.8rem; color: var(--vscode-descriptionForeground); margin-top: 4px; display: flex; justify-content: space-between; }
    </style>
</head>
<body class="${vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? 'vscode-dark' : 'vscode-light'}">
    <div class="container">
        <h2>Google SERP Simulator</h2>
        
        <div class="preview-box">
            <div class="google-res">
                <div class="cite" id="preview-url">datex2.bike › products</div>
                <div class="g-title" id="preview-title">...</div>
                <div class="g-desc" id="preview-desc">...</div>
            </div>
        </div>

        <div class="editor-section">
            <div class="input-group">
                <label>Title Tag</label>
                <input type="text" id="edit-title" placeholder="SEO Title">
                <div class="progress-bar"><div class="progress-fill" id="bar-title"></div></div>
                <div class="meta-info"><span>Target: 60 chars</span><span id="pixel-width-title">0px</span></div>
            </div>

            <div class="input-group">
                <label>Meta Description</label>
                <textarea id="edit-desc" placeholder="SEO Description"></textarea>
                <div class="progress-bar"><div class="progress-fill" id="bar-desc"></div></div>
                <div class="meta-info"><span>Target: 160 chars</span><span id="pixel-width-desc">0px</span></div>
            </div>
            
            <div class="input-group" style="padding-top: 10px; border-top: 1px solid var(--vscode-widget-border);">
                <label>Product Description (Live WYSIWYG)</label>
                <div style="margin-bottom:5px; font-size:0.8em; opacity:0.7">
                    Mode: <span id="desc-mode">Unknown</span> <span id="desc-path"></span>
                </div>
                <!-- Replaced old edit-prod-desc with a host div for Shadow DOM -->
                <div id="wysiwyg-host" class="wysiwyg-host"></div>
            </div>
        </div>
    </div>

    <canvas id="measure-canvas" style="display:none"></canvas>

    <script>
        const vscode = acquireVsCodeApi();
        
        const previewTitle = document.getElementById('preview-title');
        const previewDesc = document.getElementById('preview-desc');
        const previewUrl = document.getElementById('preview-url');

        const editTitle = document.getElementById('edit-title');
        const editDesc = document.getElementById('edit-desc');
        // Shadow DOM Host
        const descHost = document.getElementById('desc-mode').parentNode.parentNode.querySelector('.wysiwyg-host');
        // Ensure host exists or create it if I missed it in HTML? I need to update HTML below.
        
        let shadowRoot;
        let editProdDesc; 
        let cssContainer;
        
        // Initialize Shadow DOM
        function initShadowDOM() {
             const host = document.getElementById('wysiwyg-host');
             if (!host) return;
             if (host.shadowRoot) return; // already done

             shadowRoot = host.attachShadow({mode: 'open'});
             
             // Container for CSS links
             cssContainer = document.createElement('div');
             shadowRoot.appendChild(cssContainer);
             
             // Default Editor Container
             editProdDesc = document.createElement('div');
             editProdDesc.id = 'edit-prod-desc';
             editProdDesc.className = 'wysiwyg-editor';
             editProdDesc.contentEditable = true;
             // Default styles for the editor box itself inside shadow
             const style = document.createElement('style');
             style.textContent = \`
                :host { display: block; }
                .wysiwyg-editor {
                    min-height: 200px;
                    border: 1px solid var(--vscode-input-border);
                    background: #fff; 
                    color: #222; 
                    padding: 10px;
                    overflow: auto;
                    border-radius: 2px;
                    white-space: normal;
                    font-family: Arial, sans-serif; /* Default font if no CSS */
                }
                .wysiwyg-editor:focus { outline: 1px solid var(--vscode-focusBorder); }
             \`;
             shadowRoot.appendChild(style);
             shadowRoot.appendChild(editProdDesc);
             
             // Re-attach input listener
             editProdDesc.addEventListener('input', () => {
                debouncedNotifyContent('productDescription', editProdDesc.innerHTML);
             });
        }

        const descMode = document.getElementById('desc-mode');
        const descPath = document.getElementById('desc-path');
        
        // ... (bars/canvas logic unchanged)
        const barTitle = document.getElementById('bar-title');
        const barDesc = document.getElementById('bar-desc');
        const pxTitle = document.getElementById('pixel-width-title');
        const pxDesc = document.getElementById('pixel-width-desc');
        const canvas = document.getElementById('measure-canvas');
        const ctx = canvas.getContext('2d');

        let isUpdatingFromExtension = false;

        function getTextWidth(text, font) {
            ctx.font = font;
            return ctx.measureText(text).width;
        }

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'update':
                    isUpdatingFromExtension = true;
                    // Ensure shadow is ready
                    if (!shadowRoot) initShadowDOM();
                    updateUI(message.data);
                    isUpdatingFromExtension = false;
                    break;
                case 'clear':
                    break;
            }
        });

        function updateUI(data) {
            if (data.title !== undefined) {
                previewTitle.innerText = data.title;
                if (document.activeElement !== editTitle) editTitle.value = data.title;
            }
            
            if (data.description !== undefined) {
                previewDesc.innerText = data.description;
                if (document.activeElement !== editDesc) editDesc.value = data.description;
            }
            
            if (data.productDescription !== undefined) {
                // Check focus inside shadow dom
                const isActive = shadowRoot && shadowRoot.activeElement === editProdDesc;
                if (!isActive && editProdDesc) {
                    editProdDesc.innerHTML = data.productDescription;
                }
            }
            
            if (data.descriptionMode) {
                descMode.innerText = data.descriptionMode.toUpperCase();
                if (data.descriptionMode === 'file' && data.descriptionPath) {
                    const parts = data.descriptionPath.split(/[\\\\/]/);
                    descPath.innerText = ' (' + parts[parts.length-1] + ')';
                } else {
                    descPath.innerText = '';
                }
            }
            
            if (data.cssLinks && cssContainer) {
                // Simple Diff: Check if links changed string-wise? 
                // Or just clear and rebuild. Rebuilding <link> is cheap locally.
                cssContainer.innerHTML = '';
                data.cssLinks.forEach(link => {
                    const linkElem = document.createElement('link');
                    linkElem.rel = 'stylesheet';
                    linkElem.href = link;
                    cssContainer.appendChild(linkElem);
                });
            }

            if (data.debugCssPaths) {
                console.log("CSS Path Debug:", data.debugCssPaths);
            }
            
            previewUrl.innerText = data.url ? data.url.replace('https://', '').replace(/\\//g, ' › ') : 'datex2.bike';
            
            updateMetrics();
        }
        
        // ... (updateMetrics unchanged) ...

        
        function updateMetrics() {
            const titleText = editTitle.value;
            const descText = editDesc.value;
            
            const titleWidth = getTextWidth(titleText, "20px Arial");
            const descWidth = getTextWidth(descText, "14px Arial");
            
            const maxTitlePx = 600;
            const maxDescPx = 960; 

            const titleP = Math.min((titleWidth / maxTitlePx) * 100, 100);
            barTitle.style.width = titleP + '%';
            barTitle.className = 'progress-fill' + (titleWidth > maxTitlePx ? ' danger' : (titleWidth > 580 ? ' warning' : ''));
            
            const descP = Math.min((descWidth / maxDescPx) * 100, 100);
            barDesc.style.width = descP + '%';
            barDesc.className = 'progress-fill' + (descWidth > maxDescPx ? ' danger' : (descWidth > 920 ? ' warning' : ''));
            
            pxTitle.innerText = Math.round(titleWidth) + 'px';
            pxDesc.innerText = Math.round(descWidth) + 'px';
            
            previewTitle.innerText = titleText;
            previewDesc.innerText = descText;
        }

        const debounce = (func, wait) => {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        };
        
        const notifyExtension = (field, value) => {
             if(!isUpdatingFromExtension) {
                vscode.postMessage({ command: 'updateField', field: field, value: value });
             }
        };

        const debouncedNotify = debounce(notifyExtension, 300);
        const debouncedNotifyContent = debounce(notifyExtension, 600); 

        editTitle.addEventListener('input', () => {
            updateMetrics();
            debouncedNotify('title', editTitle.value);
        });
        
        editDesc.addEventListener('input', () => {
             updateMetrics();
             debouncedNotify('description', editDesc.value);
        });
        
        // editProdDesc is created dynamically inside initShadowDOM, we can't attach here yet.
        // It's already attached inside initShadowDOM!
        // Removing the duplicate/premature attachment that caused the error.

        vscode.postMessage({ command: 'requestUpdate' });
    </script>
</body>
</html>`;
    }
}

module.exports = {
    activate: function(context) {
        context.subscriptions.push(
            vscode.commands.registerCommand('datex2.showSeoPreview', () => {
                SeoPreviewPanel.createOrShow(context.extensionUri);
            })
        );
    }
};
