// AutoPipe Plugin: hdf5-viewer
// HDF5 tree explorer with dataset preview (via jsfive CDN)

(function() {
  var rootEl = null;
  var hdf5File = null;
  var treeData = [];
  var selectedPath = '';
  var expandedPaths = {};

  var JSFIVE_CDN = 'https://cdn.jsdelivr.net/npm/jsfive@0.3.10/dist/browser/hdf5.js';

  function loadScript(url, cb) {
    if (window.hdf5) { cb(); return; }
    var s = document.createElement('script');
    s.src = url;
    s.onload = function() { cb(); };
    s.onerror = function() { cb(new Error('Failed to load jsfive')); };
    document.head.appendChild(s);
  }

  function isDataset(obj) {
    if (!obj) return false;
    try { if (obj.shape && obj.shape.length > 0) return true; } catch(e) {}
    try { if (obj.dtype) return true; } catch(e) {}
    try { if (obj.value !== undefined && obj.keys === undefined) return true; } catch(e) {}
    return false;
  }

  function isGroupObj(obj) {
    if (!obj) return false;
    try { return obj.keys !== undefined && !isDataset(obj); } catch(e) { return false; }
  }

  function getChildKeys(obj) {
    try { return obj.keys ? obj.keys : Object.keys(obj); } catch(e) { return []; }
  }

  function walkTree(group, path, depth) {
    var nodes = [];
    if (depth > 8) return nodes;
    var keys = getChildKeys(group);

    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var childPath = path ? path + '/' + key : key;
      var child;
      try { child = group.get(key); } catch(e) { continue; }
      if (!child) continue;

      var dataset = isDataset(child);
      var grp = isGroupObj(child);

      // If it has both keys and shape, treat as a hybrid (group with data)
      var hasChildren = false;
      try { hasChildren = grp || (child.keys !== undefined && getChildKeys(child).length > 0 && !dataset); } catch(e) {}

      // Some h5ad objects have keys AND shape — they are datasets inside a group-like wrapper
      var hasKeysAndShape = false;
      try { hasKeysAndShape = child.keys !== undefined && child.shape && child.shape.length > 0; } catch(e) {}

      var nodeIsGroup = hasChildren && !hasKeysAndShape;

      var node = {
        name: key,
        path: childPath,
        depth: depth,
        isGroup: nodeIsGroup,
        isDataset: dataset || hasKeysAndShape,
        shape: null,
        dtype: null
      };

      if (dataset || hasKeysAndShape) {
        try { node.shape = child.shape; } catch(e) {}
        try { node.dtype = child.dtype; } catch(e) {}
      }

      nodes.push(node);

      if (nodeIsGroup && expandedPaths[childPath]) {
        var children = walkTree(child, childPath, depth + 1);
        for (var j = 0; j < children.length; j++) nodes.push(children[j]);
      }
    }
    return nodes;
  }

  function getAttrs(obj) {
    var attrs = {};
    try {
      if (obj.attrs) {
        var akeys = Object.keys(obj.attrs);
        for (var i = 0; i < Math.min(akeys.length, 20); i++) {
          var v = obj.attrs[akeys[i]];
          attrs[akeys[i]] = typeof v === 'object' ? JSON.stringify(v).substring(0, 200) : String(v).substring(0, 200);
        }
      }
    } catch(e) {}
    return attrs;
  }

  var MAX_ELEMENTS = 1000000;
  var MAX_PREVIEW_ROWS = 50;
  var MAX_PREVIEW_COLS = 10;

  function totalElements(shape) {
    if (!shape || !shape.length) return 0;
    var n = 1;
    for (var i = 0; i < shape.length; i++) n *= shape[i];
    return n;
  }

  function formatVal(v) {
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4);
    return String(v);
  }

  function getDataPreview(dataset) {
    try {
      var shape = dataset.shape;
      var total = totalElements(shape);

      if (total > MAX_ELEMENTS) {
        return '<div class="data-too-large">Dataset too large to preview (' +
          total.toLocaleString() + ' elements, ' + shape.join(' x ') +
          '). Use Python to access this data.</div>';
      }

      var val = dataset.value;
      if (!val) return '<span style="color:#999">(empty)</span>';

      // 2D array
      if (shape && shape.length === 2) {
        var rows = shape[0];
        var cols = shape[1];
        var showRows = Math.min(rows, MAX_PREVIEW_ROWS);
        var showCols = Math.min(cols, MAX_PREVIEW_COLS);

        var html = '<div class="data-size-info">' + rows.toLocaleString() + ' rows x ' +
          cols.toLocaleString() + ' columns';
        if (showRows < rows || showCols < cols) {
          html += ' (showing ' + showRows + ' x ' + showCols + ')';
        }
        html += '</div>';
        html += '<div class="data-table-wrap"><table class="data-table">';
        html += '<thead><tr><th>#</th>';
        for (var c = 0; c < showCols; c++) html += '<th>' + c + '</th>';
        if (showCols < cols) html += '<th>...</th>';
        html += '</tr></thead><tbody>';
        for (var r = 0; r < showRows; r++) {
          html += '<tr><td class="row-idx">' + r + '</td>';
          for (var c2 = 0; c2 < showCols; c2++) {
            html += '<td>' + formatVal(val[r * cols + c2]) + '</td>';
          }
          if (showCols < cols) html += '<td>...</td>';
          html += '</tr>';
        }
        if (showRows < rows) {
          html += '<tr><td colspan="' + (showCols + 2) + '" style="text-align:center;color:#999;padding:8px">... ' +
            (rows - showRows).toLocaleString() + ' more rows</td></tr>';
        }
        html += '</tbody></table></div>';
        return html;
      }

      // 1D array
      if (Array.isArray(val) || ArrayBuffer.isView(val)) {
        var len = val.length;
        var arr = Array.from(val).slice(0, 100);
        var text = arr.map(formatVal).join(', ');
        if (len > 100) text += '\n... (' + len.toLocaleString() + ' total elements)';
        return '<pre>' + text + '</pre>';
      }

      // Scalar or string
      return '<pre>' + String(val).substring(0, 5000) + '</pre>';
    } catch(e) {
      return '<span style="color:#c62828">(unable to read: ' + e.message + ')</span>';
    }
  }

  function buildTree() {
    if (!hdf5File) return;
    treeData = walkTree(hdf5File, '', 0);
  }

  function renderDetail(path) {
    var obj;
    try { obj = hdf5File.get(path); } catch(e) { return '<div class="data-empty">Unable to read: ' + path + '</div>'; }
    if (!obj) return '<div class="data-empty">Unable to read: ' + path + '</div>';

    var dataset = isDataset(obj);
    var grp = isGroupObj(obj);
    var html = '';

    html += '<div class="data-title">' + (dataset ? '\uD83D\uDCCA ' : '\uD83D\uDCC1 ') + path + '</div>';

    // Shape & dtype for datasets
    if (dataset) {
      html += '<div class="data-meta">';
      try { if (obj.shape) html += '<span class="meta-item">Shape: <b>' + obj.shape.join(' x ') + '</b></span>'; } catch(e) {}
      try { if (obj.dtype) html += '<span class="meta-item">Dtype: <b>' + obj.dtype + '</b></span>'; } catch(e) {}
      html += '</div>';
    }

    // Attributes
    var attrs = getAttrs(obj);
    var attrKeys = Object.keys(attrs);
    if (attrKeys.length > 0) {
      html += '<div class="data-attrs">';
      html += '<div class="data-attrs-title">Attributes (' + attrKeys.length + ')</div>';
      for (var ai = 0; ai < attrKeys.length; ai++) {
        html += '<div class="attr-row"><b>' + attrKeys[ai] + '</b>: ' + attrs[attrKeys[ai]] + '</div>';
      }
      html += '</div>';
    }

    // Data preview for datasets
    if (dataset) {
      html += '<div class="data-preview-title">Data Preview</div>';
      html += '<div class="data-preview">' + getDataPreview(obj) + '</div>';
    } else if (grp) {
      // Group: show children list
      var childKeys = getChildKeys(obj);
      html += '<div class="data-preview-title">Children (' + childKeys.length + ')</div>';
      html += '<div class="data-preview">';
      for (var ci = 0; ci < childKeys.length; ci++) {
        html += childKeys[ci] + '\n';
      }
      html += '</div>';
    }

    return html;
  }

  function render() {
    if (!rootEl) return;
    buildTree();

    var html = '<div class="hdf5-plugin">';

    // Tree panel
    html += '<div class="hdf5-tree-panel">';
    html += '<div class="hdf5-tree-header">HDF5 Structure</div>';
    for (var i = 0; i < treeData.length; i++) {
      var node = treeData[i];
      var indent = node.depth * 16;
      var selClass = node.path === selectedPath ? ' selected' : '';
      var typeClass = node.isGroup ? 'tree-group' : 'tree-dataset';
      var icon;
      if (node.isGroup) {
        icon = expandedPaths[node.path] ? '\u25BC' : '\u25B6';
      } else {
        icon = '\u25A0';
      }

      html += '<div class="tree-node ' + typeClass + selClass + '" data-path="' + node.path + '" data-isgroup="' + node.isGroup + '">';
      html += '<span class="tree-indent" style="width:' + indent + 'px"></span>';
      html += '<span class="tree-icon">' + icon + '</span>';
      html += node.name;
      if (node.isDataset && node.shape) {
        html += ' <span style="color:#999;font-size:10px">[' + node.shape.join('x') + ']</span>';
      }
      html += '</div>';
    }
    html += '</div>';

    // Data panel
    html += '<div class="hdf5-data-panel">';
    if (selectedPath) {
      html += renderDetail(selectedPath);
    } else {
      html += '<div class="data-empty">Select an item from the tree to view details</div>';
    }
    html += '</div>';

    html += '</div>';
    rootEl.innerHTML = html;

    // Events
    var nodes = rootEl.querySelectorAll('.tree-node');
    for (var ni = 0; ni < nodes.length; ni++) {
      nodes[ni].addEventListener('click', function() {
        var path = this.getAttribute('data-path');
        var isGroup = this.getAttribute('data-isgroup') === 'true';
        if (isGroup) {
          expandedPaths[path] = !expandedPaths[path];
        }
        selectedPath = path;
        render();
      });
    }
  }

  window.AutoPipePlugin = {
    render: function(container, fileUrl, filename) {
      rootEl = container;
      rootEl.innerHTML = '<div class="hdf5-loading">Loading ' + filename + '...</div>';
      hdf5File = null; treeData = []; selectedPath = ''; expandedPaths = {};

      loadScript(JSFIVE_CDN, function(err) {
        if (err) {
          rootEl.innerHTML = '<div class="hdf5-error">Failed to load jsfive library.</div>';
          return;
        }

        fetch(fileUrl)
          .then(function(resp) { return resp.arrayBuffer(); })
          .then(function(buf) {
            try {
              hdf5File = new hdf5.File(buf);
              render();
            } catch(e) {
              rootEl.innerHTML = '<div class="hdf5-error">Error parsing HDF5 file: ' + e.message + '</div>';
            }
          })
          .catch(function(err) {
            rootEl.innerHTML = '<div class="hdf5-error">Error loading file: ' + err.message + '</div>';
          });
      });
    },
    destroy: function() { hdf5File = null; treeData = []; rootEl = null; }
  };
})();
