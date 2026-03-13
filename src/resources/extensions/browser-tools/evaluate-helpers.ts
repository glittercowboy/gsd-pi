/**
 * browser-tools — browser-side evaluate helpers
 *
 * Exports a single string constant `EVALUATE_HELPERS_SOURCE` containing an IIFE
 * that attaches utility functions to `window.__pi`.  This is injected into every
 * new BrowserContext via `context.addInitScript()` so that `page.evaluate()`
 * callbacks can reference `window.__pi.cssPath(el)` etc. instead of redeclaring
 * the same functions inline.
 *
 * The `simpleHash` function uses the djb2 algorithm identical to
 * `computeContentHash` / `computeStructuralSignature` in `core.js`.
 *
 * Functions provided (9):
 *   cssPath, simpleHash, isVisible, isEnabled, inferRole,
 *   accessibleName, isInteractiveEl, domPath, selectorHints
 */

export const EVALUATE_HELPERS_SOURCE = `(function() {
  var pi = window.__pi = window.__pi || {};

  // -----------------------------------------------------------------------
  // 1. simpleHash — djb2 hash matching core.js computeContentHash
  // -----------------------------------------------------------------------
  pi.simpleHash = function simpleHash(str) {
    if (!str) return "0";
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
  };

  // -----------------------------------------------------------------------
  // 2. isVisible
  // -----------------------------------------------------------------------
  pi.isVisible = function isVisible(el) {
    var style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  // -----------------------------------------------------------------------
  // 3. isEnabled
  // -----------------------------------------------------------------------
  pi.isEnabled = function isEnabled(el) {
    var disabledAttr = el.getAttribute("disabled") !== null;
    var ariaDisabled = (el.getAttribute("aria-disabled") || "").toLowerCase() === "true";
    return !disabledAttr && !ariaDisabled;
  };

  // -----------------------------------------------------------------------
  // 4. inferRole
  // -----------------------------------------------------------------------
  pi.inferRole = function inferRole(el) {
    var explicit = (el.getAttribute("role") || "").trim();
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === "a" && el.getAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset"].indexOf(type) !== -1) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    return "";
  };

  // -----------------------------------------------------------------------
  // 5. accessibleName
  // -----------------------------------------------------------------------
  pi.accessibleName = function accessibleName(el) {
    var ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
    var labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy && labelledBy.trim()) {
      var text = labelledBy.trim().split(/\\s+/).map(function(id) {
        var ref = document.getElementById(id);
        return ref ? (ref.textContent || "").trim() : "";
      }).join(" ").trim();
      if (text) return text;
    }
    var placeholder = el.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) return placeholder.trim();
    var alt = el.getAttribute("alt");
    if (alt && alt.trim()) return alt.trim();
    var value = el.value;
    if (value && typeof value === "string" && value.trim()) return value.trim().slice(0, 80);
    return (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80);
  };

  // -----------------------------------------------------------------------
  // 6. isInteractiveEl
  // -----------------------------------------------------------------------
  var interactiveRoles = {
    button: 1, link: 1, textbox: 1, searchbox: 1, combobox: 1,
    checkbox: 1, radio: 1, "switch": 1, menuitem: 1,
    menuitemcheckbox: 1, menuitemradio: 1, tab: 1, option: 1,
    slider: 1, spinbutton: 1
  };
  pi.isInteractiveEl = function isInteractiveEl(el) {
    var tag = el.tagName.toLowerCase();
    var role = pi.inferRole(el);
    if (["button", "input", "select", "textarea", "summary", "option"].indexOf(tag) !== -1) return true;
    if (tag === "a" && !!el.getAttribute("href")) return true;
    if (interactiveRoles[role]) return true;
    if (el.tabIndex >= 0) return true;
    if (el.isContentEditable) return true;
    return false;
  };

  // -----------------------------------------------------------------------
  // 7. cssPath
  // -----------------------------------------------------------------------
  pi.cssPath = function cssPath(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    var parts = [];
    var current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      var tag = current.tagName.toLowerCase();
      var part = tag;
      var parent = current.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function(c) {
          return c.tagName === current.tagName;
        });
        if (siblings.length > 1) {
          var idx = siblings.indexOf(current) + 1;
          part += ":nth-of-type(" + idx + ")";
        }
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return "body > " + parts.join(" > ");
  };

  // -----------------------------------------------------------------------
  // 8. domPath
  // -----------------------------------------------------------------------
  pi.domPath = function domPath(el) {
    var path = [];
    var current = el;
    while (current && current !== document.documentElement) {
      var parent = current.parentElement;
      if (!parent) break;
      var idx = Array.from(parent.children).indexOf(current);
      path.unshift(idx);
      current = parent;
    }
    return path;
  };

  // -----------------------------------------------------------------------
  // 9. selectorHints
  // -----------------------------------------------------------------------
  pi.selectorHints = function selectorHints(el) {
    var hints = [];
    if (el.id) hints.push("#" + CSS.escape(el.id));
    var nameAttr = el.getAttribute("name");
    if (nameAttr) hints.push(el.tagName.toLowerCase() + '[name="' + CSS.escape(nameAttr) + '"]');
    var aria = el.getAttribute("aria-label");
    if (aria) hints.push(el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(aria) + '"]');
    var placeholder = el.getAttribute("placeholder");
    if (placeholder) hints.push(el.tagName.toLowerCase() + '[placeholder="' + CSS.escape(placeholder) + '"]');
    var cls = Array.from(el.classList).slice(0, 2);
    if (cls.length > 0) hints.push(el.tagName.toLowerCase() + "." + cls.map(function(c) { return CSS.escape(c); }).join("."));
    hints.push(pi.cssPath(el));
    var seen = {};
    var unique = [];
    for (var i = 0; i < hints.length; i++) {
      if (!seen[hints[i]]) {
        seen[hints[i]] = true;
        unique.push(hints[i]);
      }
    }
    return unique.slice(0, 6);
  };
})();`;
