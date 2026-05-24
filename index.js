// AutoPipe Plugin: hdf5-viewer (v2 — server-side h5py extraction)
//
// The previous jsfive-based implementation parsed HDF5 entirely in the browser,
// which required downloading the whole file. That failed for large h5ad files
// (the server returns an empty body for files >= 10MB without a Range request),
// and large files would also freeze the browser.
//
// This version delegates parsing to server-side h5py (run via Docker on the SSH
// server, defined in manifest.json's data_source). The server returns a JSON tree:
//   { name, type:'group'|'dataset', children?, shape?, dtype?, attrs?, values?, too_large? }
// Small datasets include `values`; large datasets carry `too_large:true` so the
// browser never has to load big arrays.
//
// The old jsfive implementation is preserved in index.js.jsfive_backup.

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

    if (node.too_large) {
      html += '<div class="h5-toolarge">This dataset is too large to display in the viewer ' +
              '(' + esc(shapeStr(node.shape)) + ').<br>Download the file to inspect its full contents.</div>';
    } else if (node.error) {
      html += '<div class="h5-toolarge">Could not read values: ' + esc(node.error) + '</div>';
    } else if (node.values !== undefined) {
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
  window.AutoPipePlugin = {
    render: function(container, fileUrl, filename) {
      rootEl = container;
      rootEl.innerHTML = '<div class="ap-loading">Extracting HDF5 structure on the server (this may take a moment for the first run)...</div>';
      tree = null; selectedNode = null; expanded = {};

      // The server runs h5py (via manifest data_source) and returns the tree
      // as a JSON string in `meta` (meta_parse: "none").
      fetch('/data/' + encodeURIComponent(filename) + '?page=0')
        .then(function(resp) { return resp.json(); })
        .then(function(data) {
          if (data.error) {
            rootEl.innerHTML = '<div class="hdf5-error">Error: ' + esc(data.error) + '</div>';
            return;
          }
          var raw = data.meta;
          if (!raw) {
            rootEl.innerHTML = '<div class="hdf5-error">Server returned no structure. The h5py extraction may have failed.</div>';
            return;
          }
          try {
            tree = (typeof raw === 'string') ? JSON.parse(raw) : raw;
          } catch (e) {
            rootEl.innerHTML = '<div class="hdf5-error">Failed to parse structure JSON: ' + esc(e.message) +
              '<br><pre style="font-size:11px;max-height:200px;overflow:auto">' + esc(String(raw).slice(0, 2000)) + '</pre></div>';
            return;
          }
          assignPaths(tree, '/');
          render();
        })
        .catch(function(err) {
          rootEl.innerHTML = '<div class="hdf5-error">Error loading structure: ' + esc(err.message) + '</div>';
        });
    },
    destroy: function() { tree = null; selectedNode = null; rootEl = null; }
  };
})();
