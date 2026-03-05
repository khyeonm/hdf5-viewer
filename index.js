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
    if (window.jsfive) { cb(); return; }
    var s = document.createElement('script');
    s.src = url;
    s.onload = function() { cb(); };
    s.onerror = function() { cb(new Error('Failed to load jsfive')); };
    document.head.appendChild(s);
  }

  function walkTree(group, path, depth) {
    var nodes = [];
    if (depth > 5) return nodes;
    var keys;
    try { keys = group.keys ? group.keys : Object.keys(group); } catch(e) { return nodes; }

    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var childPath = path ? path + '/' + key : key;
      var child;
      try { child = group.get(key); } catch(e) { continue; }

      if (!child) continue;

      var isGroup = child.keys !== undefined || (child.type === 'Group');
      var node = {
        name: key,
        path: childPath,
        depth: depth,
        isGroup: isGroup,
        shape: null,
        dtype: null
      };

      if (!isGroup) {
        try { node.shape = child.shape; } catch(e) {}
        try { node.dtype = child.dtype; } catch(e) {}
      }

      nodes.push(node);

      if (isGroup && expandedPaths[childPath]) {
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

  function getDataPreview(dataset, maxElements) {
    maxElements = maxElements || 100;
    try {
      var val = dataset.value;
      if (!val) return '(empty)';
      if (Array.isArray(val) || ArrayBuffer.isView(val)) {
        var arr = Array.from(val).slice(0, maxElements);
        var total = val.length || 0;
        var text = arr.join(', ');
        if (total > maxElements) text += '\n... (' + total.toLocaleString() + ' total elements)';
        return text;
      }
      return String(val).substring(0, 5000);
    } catch(e) {
      return '(unable to read: ' + e.message + ')';
    }
  }

  function buildTree() {
    if (!hdf5File) return;
    treeData = walkTree(hdf5File, '', 0);
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
      var icon = node.isGroup ? (expandedPaths[node.path] ? '\u25BC' : '\u25B6') : '\u25A0';

      html += '<div class="tree-node ' + typeClass + selClass + '" data-path="' + node.path + '" data-isgroup="' + node.isGroup + '">';
      html += '<span class="tree-indent" style="width:' + indent + 'px"></span>';
      html += '<span class="tree-icon">' + icon + '</span>';
      html += node.name;
      if (!node.isGroup && node.shape) {
        html += ' <span style="color:#999;font-size:10px">[' + node.shape.join('x') + ']</span>';
      }
      html += '</div>';
    }
    html += '</div>';

    // Data panel
    html += '<div class="hdf5-data-panel">';
    if (selectedPath) {
      var obj;
      try { obj = hdf5File.get(selectedPath); } catch(e) { obj = null; }

      if (obj) {
        var isGroup = obj.keys !== undefined;
        html += '<div class="data-title">' + (isGroup ? '\uD83D\uDCC1 ' : '\uD83D\uDCCA ') + selectedPath + '</div>';

        // Meta
        if (!isGroup) {
          html += '<div class="data-meta">';
          try { if (obj.shape) html += '<span class="meta-item">Shape: <b>' + obj.shape.join(' x ') + '</b></span>'; } catch(e) {}
          try { if (obj.dtype) html += '<span class="meta-item">Dtype: <b>' + obj.dtype + '</b></span>'; } catch(e) {}
          html += '</div>';
        }

        // Attrs
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

        // Data preview
        if (!isGroup) {
          html += '<div class="data-preview-title">Data Preview</div>';
          html += '<div class="data-preview">' + getDataPreview(obj) + '</div>';
        } else {
          var childKeys;
          try { childKeys = obj.keys ? obj.keys : Object.keys(obj); } catch(e) { childKeys = []; }
          html += '<div class="data-preview-title">Children (' + childKeys.length + ')</div>';
          html += '<div class="data-preview">' + childKeys.join('\n') + '</div>';
        }
      } else {
        html += '<div class="data-empty">Unable to read: ' + selectedPath + '</div>';
      }
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
              hdf5File = new jsfive.File(buf);
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
