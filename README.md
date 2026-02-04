# DATEx2 Smart Navigation
DATE x2 Smart Navigation

This extension provides smart navigation features for DATEx2 development.

## Features

### 1. Instant Product File Toggle (F12)
*   **Press F12** while viewing a product `.js` or `.json` file.
*   Instantly opens the counterpart file (`.js` <-> `.json`).
*   **Smart Context Awareness:** Preserves cursor position within keys and values.

<img src="assets/icon.webp" alt="F12 Toggle Infographic" width="100%"/>

### 2. Translation Cache Toggle (Ctrl+Alt+T)
*   **Press Ctrl+Alt+T** on a text string or key in any file to jump to its entry in `translations.ai.cache.json`.
*   **Press Ctrl+Alt+T** inside the translation cache file to jump back to the referenced source file (using the "refs" property).

### 3. Thumbnail Reference Cycling (F12)
*   **Press F12** while cursor is on a thumbnail path (e.g. `"thumbs/image.webp"`) in a `product.js` or `thumbs.json` file.
*   **Cycles References:** Navigates from the usage -> registry definition (`thumbs.json`) -> each reference in other products -> back to usage.
*   Allows quick inspection of where an image is used across the entire product catalog.

### 4. Path Variable Expansion
*   Resolves `${variable}` paths in JSON document links and keys.

### 5. Enhanced Image Previews
*   **Smart Data URI Handling:** Automatically offloads large `data:image` preview content (>~50KB) to temporary files to bypass VS Code's markdown hover limits, ensuring even high-resolution embedded images display correctly.



## Configuration

Set variables in your settings:
```json
{
  "products": "/absolute/path/to/products"
}
```

## Development & Deployment

**IMPORTANT FOR ANTIGRAVITY ENVIRONMENT:**

When developing in the **Antigravity** environment, you **MUST** use the following command to bump the version, package, and **install** the extension immediately:

```bash
npm run update-package
```

Do **NOT** just run `npm run package` or `vsce package`, as this will not install the updated extension into the current active environment. The `update-package` script handles version bumping, packaging, and force-installing the `.vsix`.
