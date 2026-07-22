// AutoPipe Plugin: hdf5-viewer
//
// The tree is built in the browser with a bundled copy of jsfive, so the viewer
// works on servers without Docker or h5py. Server-side extraction (h5py via
// manifest.json's data_source) remains as a fallback for files too large to
// pull into browser memory, and for webviews that cannot run the parser.
//
// An earlier jsfive attempt was abandoned because a plain GET of the file
// returns an empty body for anything >= 10MB — the /file/ endpoint only sends
// real bytes when a Range header is present. Fetching in ranged chunks avoids
// that, which is what makes the in-browser path viable again.
//
// Both paths produce the same tree shape, so rendering is shared:
//   { name, type:'group'|'dataset', children?, shape?, dtype?, attrs?,
//     values?, preview?, total_elements?, preview_note? }

(function() {
  var rootEl = null;
  var tree = null;            // root node from server
  var selectedNode = null;    // currently selected node
  var expanded = {};          // path -> bool

  // ---- helpers ----------------------------------------------------------
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function shapeStr(shape) {
    if (!shape || !shape.length) return 'scalar';
    return '(' + shape.join(' × ') + ')';
  }

  // Assign a stable path to every node (server tree has names but no paths)
  function assignPaths(node, path) {
    node._path = path;
    if (node.type === 'group' && node.children) {
      for (var i = 0; i < node.children.length; i++) {
        var c = node.children[i];
        assignPaths(c, path === '/' ? '/' + c.name : path + '/' + c.name);
      }
    }
  }

  function findByPath(node, path) {
    if (node._path === path) return node;
    if (node.children) {
      for (var i = 0; i < node.children.length; i++) {
        var r = findByPath(node.children[i], path);
        if (r) return r;
      }
    }
    return null;
  }

  // ---- tree rendering ---------------------------------------------------
  function renderTreeNode(node, depth, out) {
    if (node._path !== '/') {
      var isGroup = node.type === 'group';
      var pad = depth * 16;
      var icon = isGroup ? (expanded[node._path] ? '▼' : '▶') : '●';
      var meta = isGroup ? '' :
        '<span class="h5-meta">' + esc(shapeStr(node.shape)) + ' ' + esc(node.dtype || '') + '</span>';
      var sel = (selectedNode && selectedNode._path === node._path) ? ' selected' : '';
      out.push(
        '<div class="h5-node' + sel + '" data-path="' + esc(node._path) + '" ' +
        'data-isgroup="' + isGroup + '" style="padding-left:' + pad + 'px">' +
        '<span class="h5-icon">' + icon + '</span>' +
        '<span class="h5-name">' + esc(node.name) + '</span>' + meta +
        '</div>'
      );
    }
    if (node.type === 'group' && node.children && (node._path === '/' || expanded[node._path])) {
      for (var i = 0; i < node.children.length; i++) {
        renderTreeNode(node.children[i], node._path === '/' ? 0 : depth + 1, out);
      }
    }
  }

  // ---- detail panel -----------------------------------------------------
  function renderAttrs(attrs) {
    if (!attrs) return '';
    var keys = Object.keys(attrs);
    if (!keys.length) return '';
    var rows = '';
    for (var i = 0; i < keys.length; i++) {
      var v = attrs[keys[i]];
      if (typeof v === 'object') v = JSON.stringify(v);
      rows += '<tr><td class="h5-attr-k">' + esc(keys[i]) + '</td><td>' + esc(String(v)) + '</td></tr>';
    }
    return '<div class="h5-section">Attributes</div><table class="h5-attrs">' + rows + '</table>';
  }

  function renderValues(node) {
    var v = node.values;
    // scalar
    if (!Array.isArray(v)) {
      return '<div class="h5-section">Value</div><pre class="h5-values">' + esc(String(v)) + '</pre>';
    }
    // 1D
    if (!Array.isArray(v[0])) {
      var items = v.slice(0, 1000).map(function(x) { return esc(String(x)); });
      return '<div class="h5-section">Values (' + v.length + ')</div>' +
        '<pre class="h5-values">[' + items.join(', ') + ']</pre>';
    }
    // 2D — render as table
    var html = '<div class="h5-section">Values ' + esc(shapeStr(node.shape)) + '</div>';
    html += '<div class="h5-table-wrap"><table class="h5-table"><tbody>';
    for (var r = 0; r < Math.min(v.length, 100); r++) {
      html += '<tr>';
      var row = v[r];
      for (var c = 0; c < Math.min(row.length, 50); c++) {
        html += '<td>' + esc(String(row[c])) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
  }

  function renderDetail(node) {
    if (!node) {
      return '<div class="h5-empty">Select a dataset or group from the tree.</div>';
    }
    var html = '<div class="h5-detail-head">' + esc(node._path) + '</div>';

    if (node.type === 'group') {
      var n = node.children ? node.children.length : 0;
      html += '<div class="h5-info">Group with ' + n + ' item' + (n === 1 ? '' : 's') + '</div>';
      html += renderAttrs(node.attrs);
      return html;
    }

    // dataset
    html += '<div class="h5-info"><b>Shape:</b> ' + esc(shapeStr(node.shape)) +
            ' &nbsp; <b>Dtype:</b> ' + esc(node.dtype || '?') + '</div>';
    html += renderAttrs(node.attrs);

    if (node.error) {
      html += '<div class="h5-toolarge">Could not read values: ' + esc(node.error) + '</div>';
    } else if (node.values !== undefined) {
      if (node.preview) {
        html += '<div class="h5-preview-note">Preview: ' + esc(node.preview_note || 'partial') +
                '. Dataset is too large to display fully — download the file for complete contents.</div>';
      }
      html += renderValues(node);
    } else {
      html += '<div class="h5-info">No preview available.</div>';
    }
    return html;
  }

  // ---- main render ------------------------------------------------------
  function render() {
    if (!rootEl || !tree) return;
    var treeOut = [];
    renderTreeNode(tree, 0, treeOut);

    var html = '<div class="h5-plugin">';
    html += '<div class="h5-tree">' + treeOut.join('') + '</div>';
    html += '<div class="h5-detail">' + renderDetail(selectedNode) + '</div>';
    html += '</div>';
    rootEl.innerHTML = html;

    var nodes = rootEl.querySelectorAll('.h5-node');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].addEventListener('click', function() {
        var path = this.getAttribute('data-path');
        var isGroup = this.getAttribute('data-isgroup') === 'true';
        if (isGroup) expanded[path] = !expanded[path];
        selectedNode = findByPath(tree, path);
        render();
      });
    }
  }

  // ---- entry ------------------------------------------------------------
  // ── In-browser parsing (jsfive) ────────────────────────────────────────

  // Files above this are left to the server: jsfive materialises the whole
  // file, and a multi-hundred-MB h5ad would exhaust the tab.
  var BROWSER_LIMIT = 100 * 1024 * 1024;
  // Matches THRESHOLD in the server-side h5py script, so both paths decide
  // "small enough to show in full" the same way.
  var FULL_VALUE_LIMIT = 1000;
  // Above this a dataset is described but never read — jsfive has no partial
  // read, so touching .value would pull the entire array into memory. Raised
  // well past the "show in full" threshold so ordinary h5ad matrices still get
  // a truncated preview rather than nothing at all.
  var READ_LIMIT = 5000000;
  var CHUNK = 8 * 1024 * 1024;

  var JSFIVE_LOCAL = '/plugin/hdf5-viewer/jsfive.js';
  var JSFIVE_CDN = 'https://cdn.jsdelivr.net/npm/jsfive@0.4.0/dist/browser/hdf5.js';

  function loadJsfive() {
    if (window.hdf5) return Promise.resolve();
    function load(src) {
      return new Promise(function(resolve, reject) {
        var el = document.createElement('script');
        el.src = src;
        el.onload = function() { resolve(); };
        el.onerror = function() { reject(new Error('Failed to load ' + src)); };
        document.head.appendChild(el);
      });
    }
    return load(JSFIVE_LOCAL).catch(function() { return load(JSFIVE_CDN); });
  }

  // /file/ only returns real bytes for ranged requests, so the file is pulled
  // in chunks and reassembled.
  function fetchFileBuffer(fileUrl) {
    return fetch(fileUrl, { headers: { Range: 'bytes=0-0' } })
      .then(function(r) {
        if (!r.ok) throw new Error('range request failed: ' + r.status);
        var cr = r.headers.get('Content-Range') || '';
        var total = parseInt(cr.split('/')[1], 10);
        if (!(total > 0)) throw new Error('could not determine file size');
        if (total > BROWSER_LIMIT) {
          throw new Error('file too large for in-browser parsing: ' + total);
        }
        var parts = [];
        function next(start) {
          if (start >= total) return Promise.resolve(parts);
          var end = Math.min(start + CHUNK, total) - 1;
          return fetch(fileUrl, { headers: { Range: 'bytes=' + start + '-' + end } })
            .then(function(cr2) {
              if (!cr2.ok) throw new Error('range request failed: ' + cr2.status);
              return cr2.arrayBuffer();
            })
            .then(function(buf) { parts.push(new Uint8Array(buf)); return next(end + 1); });
        }
        return next(0).then(function(list) {
          var out = new Uint8Array(total);
          var at = 0;
          list.forEach(function(a) { out.set(a, at); at += a.length; });
          return out.buffer;
        });
      });
  }

  function h5Attrs(obj) {
    var attrs = {};
    try {
      var src = obj.attrs || {};
      Object.keys(src).forEach(function(k) {
        var v = src[k];
        attrs[k] = (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
      });
    } catch (e) { /* attributes are best-effort */ }
    return attrs;
  }

  // A dataset is anything carrying a shape. Do not test `keys` here: jsfive
  // exposes `keys` as a method on datasets too, so checking it for undefined
  // misclassifies every dataset as a group and then blows up on keys.forEach.
  function h5IsDataset(obj) {
    try { return !!obj && obj.shape !== undefined; } catch (e) { return false; }
  }

  // Only a group's `keys` is the array of child names.
  function h5ChildKeys(obj) {
    try {
      var k = obj.keys;
      return Array.isArray(k) ? k : [];
    } catch (e) { return []; }
  }

  function elementCount(shape) {
    if (!shape || !shape.length) return 1;
    var n = 1;
    for (var i = 0; i < shape.length; i++) n *= shape[i];
    return n;
  }

  // Reshape jsfive's flat array the way the h5py script returns nested lists,
  // so renderValues sees the same structure from either path.
  function sliceValues(flat, shape, node) {
    var n = elementCount(shape);
    if (!shape.length) return flat && flat.length !== undefined ? flat[0] : flat;

    if (n <= FULL_VALUE_LIMIT) {
      if (shape.length === 1) return Array.prototype.slice.call(flat);
      if (shape.length === 2) {
        var rows = [];
        for (var r = 0; r < shape[0]; r++) {
          rows.push(Array.prototype.slice.call(flat, r * shape[1], (r + 1) * shape[1]));
        }
        return rows;
      }
      return Array.prototype.slice.call(flat);
    }

    node.preview = true;
    node.total_elements = n;
    if (shape.length === 1) {
      node.preview_note = 'first 100 of ' + shape[0];
      return Array.prototype.slice.call(flat, 0, 100);
    }
    if (shape.length === 2) {
      node.preview_note = 'first 10 x 10 of (' + shape.join(' x ') + ')';
      var out = [];
      for (var i = 0; i < Math.min(10, shape[0]); i++) {
        out.push(Array.prototype.slice.call(flat, i * shape[1], i * shape[1] + Math.min(10, shape[1])));
      }
      return out;
    }
    node.preview_note = 'first 100 (flattened) of (' + shape.join(' x ') + ')';
    return Array.prototype.slice.call(flat, 0, 100);
  }

  function h5Node(name, obj) {
    if (!h5IsDataset(obj)) {
      var children = [];
      h5ChildKeys(obj).forEach(function(k) {
        try { children.push(h5Node(k, obj.get(k))); } catch (e) {
          children.push({ name: k, type: 'dataset', shape: [], dtype: '?', attrs: {},
                          error: String(e && e.message || e) });
        }
      });
      return { name: name, type: 'group', children: children, attrs: h5Attrs(obj) };
    }

    var shape = [];
    try { shape = obj.shape || []; } catch (e) { shape = []; }
    var node = {
      name: name, type: 'dataset', shape: shape,
      dtype: String(obj.dtype || '?'), attrs: h5Attrs(obj)
    };

    var n = elementCount(shape);
    if (n > READ_LIMIT) {
      // Described but not read: jsfive would have to decode the whole array.
      node.preview = true;
      node.total_elements = n;
      node.preview_note = 'too large to read in the browser (' + n.toLocaleString() +
        ' elements) — install h5py/Docker on the server for a preview';
      return node;
    }
    try {
      node.values = sliceValues(obj.value, shape, node);
    } catch (e) {
      // A dataset that cannot be decoded should not sink the whole tree; keep
      // the node with its shape and dtype and say why the values are absent.
      node.preview = true;
      node.total_elements = n;
      node.preview_note = 'could not read values: ' + String(e && e.message || e);
    }
    return node;
  }

  function buildTreeInBrowser(fileUrl) {
    return loadJsfive()
      .then(function() { return fetchFileBuffer(fileUrl); })
      .then(function(buf) {
        var f = new hdf5.File(buf);
        return {
          name: '/', type: 'group', attrs: h5Attrs(f),
          children: h5ChildKeys(f).map(function(k) { return h5Node(k, f.get(k)); })
        };
      });
  }

  function buildTreeOnServer(filename) {
    return fetch('/data/' + encodeURIComponent(filename) + '?page=0')
      .then(function(resp) { return resp.json(); })
      .then(function(data) {
        if (data.error) throw new Error(data.error);
        var raw = data.meta;
        if (!raw) throw new Error('server returned no structure; h5py extraction may have failed');
        return (typeof raw === 'string') ? JSON.parse(raw) : raw;
      });
  }

  window.AutoPipePlugin = {
    render: function(container, fileUrl, filename) {
      rootEl = container;
      rootEl.innerHTML = '<div class="ap-loading">Reading HDF5 structure...</div>';
      tree = null; selectedNode = null; expanded = {};

      var show = function(t) {
        tree = t;
        assignPaths(tree, '/');
        render();
      };

      // Parse in the browser first so the viewer does not depend on Docker or
      // h5py being present; fall back to server extraction when the file is too
      // big to hold in memory or the parser is unavailable.
      buildTreeInBrowser(fileUrl)
        .then(show)
        .catch(function(browserErr) {
          rootEl.innerHTML =
            '<div class="ap-loading">Extracting HDF5 structure on the server ' +
            '(this may take a moment for the first run)...</div>';
          buildTreeOnServer(filename)
            .then(show)
            .catch(function(serverErr) {
              rootEl.innerHTML =
                '<div class="hdf5-error">Could not read this HDF5 file.' +
                '<br><br>In-browser parser: ' + esc(browserErr.message || String(browserErr)) +
                '<br>Server extraction: ' + esc(serverErr.message || String(serverErr)) +
                '<br><br><span style="font-size:12px;color:#888">Large files need h5py ' +
                'on the server (via Docker); smaller ones are read directly in the browser.' +
                '</span></div>';
            });
        });
    },
    destroy: function() { tree = null; selectedNode = null; rootEl = null; }
  };
})();
