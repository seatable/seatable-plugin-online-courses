import React, { useState, useMemo } from 'react';
import intl from 'react-intl-universal';
import { AssetFile } from '../../../utils/custom-interfaces/AuditTypes';
import { getAuthContext } from '../../../utils/custom-utils/authHelper';
import { fmtSize } from '../../../utils/custom-utils/formatters';
import ContextMenu from '../shared/ContextMenu';
import { showToast } from '../shared/showToast';

interface OrphanTreeProps {
  orphans: AssetFile[];
  allFiles: AssetFile[];
  accountToken: string;
  onRefresh: () => void;
  deletedPaths: Set<string>;
  onMarkDeleted: (paths: string[]) => void;
}

interface TreeNode {
  label: string;
  fullPath: string;
  files: AssetFile[];
  children: TreeNode[];
  totalSize: number;
  totalFileCount: number;
  folderTotalSize: number;
  allOrphaned: boolean;
}

function getServerConfig() {
  const config = (window as any).dtable || {};
  return {
    serverUrl: config.server || '',
    dtableUuid: config.dtableUuid || '',
    appAccessToken: config.accessToken || '',
    workspaceID: config.workspaceID || '',
    dtableName: config.dtableName || '',
  };
}

async function assetExists(path: string, accountToken: string): Promise<boolean> {
  try {
    const { serverUrl, workspaceID, dtableName } = getServerConfig();
    if (!serverUrl || !workspaceID || !dtableName) return true;
    const resp = await fetch(
      `${serverUrl}/api/v2.1/workspace/${workspaceID}/dtable/${encodeURIComponent(dtableName)}/asset-exists/?path=${encodeURIComponent(path)}`,
      { headers: { Authorization: `Bearer ${accountToken}` } }
    );
    if (!resp.ok) return true;
    const data = await resp.json();
    return data.is_exist === true;
  } catch {
    return true;
  }
}

async function deleteAsset(path: string, accountToken: string): Promise<boolean> {
  try {
    const auth = await getAuthContext();
    const { serverUrl } = getServerConfig();
    const dtableUuid = auth.dtableUuid;
    if (!serverUrl || !dtableUuid) return false;

    // Check if the asset actually exists before deleting
    if (!(await assetExists(path, accountToken))) return false;

    // Same endpoint for both regular and custom assets (custom paths start with /custom)
    if (!accountToken) return false;
    const resp = await fetch(
      `${serverUrl}/api/v2.1/dtable-asset/${dtableUuid}/?path=${encodeURIComponent(path)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accountToken}` },
      }
    );
    return resp.ok;
  } catch {
    return false;
  }
}

function buildTree(orphans: AssetFile[], allFiles: AssetFile[], prefix: string): TreeNode {
  const isCustom = prefix === '/custom';
  const filtered = orphans.filter((f) =>
    isCustom ? f.folder.startsWith('/custom') : !f.folder.startsWith('/custom')
  );
  const allFiltered = allFiles.filter((f) =>
    isCustom ? f.folder.startsWith('/custom') : !f.folder.startsWith('/custom')
  );

  // Count total files per exact folder path (for allOrphaned detection)
  const totalPerFolder: Record<string, number> = {};
  for (const f of allFiltered) {
    totalPerFolder[f.folder] = (totalPerFolder[f.folder] || 0) + 1;
  }

  // Compute total size of ALL files (not just orphans) per folder path,
  // summing recursively so parent folders include children
  const sizePerFolder: Record<string, number> = {};
  for (const f of allFiltered) {
    sizePerFolder[f.folder] = (sizePerFolder[f.folder] || 0) + f.size;
  }

  const stripPrefix = isCustom ? '/custom' : '';

  // Build a helper to sum sizes for a node path and all sub-paths
  function totalSizeUnder(nodePath: string): number {
    let total = 0;
    for (const [folder, size] of Object.entries(sizePerFolder)) {
      const relative = stripPrefix ? folder.slice(stripPrefix.length) : folder;
      const nodeRelative = stripPrefix ? nodePath.slice(stripPrefix.length) : nodePath;
      if (relative === nodeRelative || relative.startsWith(nodeRelative.replace(/\/$/, '') + '/')) {
        total += size;
      }
    }
    return total;
  }

  // Group orphans by their folder path
  const byFolder: Record<string, AssetFile[]> = {};
  for (const f of filtered) {
    if (!byFolder[f.folder]) byFolder[f.folder] = [];
    byFolder[f.folder].push(f);
  }

  const rootName = isCustom
    ? intl.get('orphans.custom_folders').d('Custom folders')
    : intl.get('orphans.system_folders').d('System folders');
  const root: TreeNode = {
    label: rootName,
    fullPath: prefix,
    files: [],
    children: [],
    totalSize: 0,
    totalFileCount: 0,
    folderTotalSize: 0,
    allOrphaned: false,
  };

  for (const [folder, files] of Object.entries(byFolder)) {
    const relative = stripPrefix ? folder.slice(stripPrefix.length) : folder;
    const parts = relative.split('/').filter(Boolean);

    let current = root;
    let builtPath = stripPrefix;

    for (const part of parts) {
      builtPath += '/' + part;
      let child = current.children.find((c) => c.label === part);
      if (!child) {
        child = {
          label: part,
          fullPath: builtPath,
          files: [],
          children: [],
          totalSize: 0,
          totalFileCount: 0,
          folderTotalSize: 0,
          allOrphaned: false,
        };
        current.children.push(child);
      }
      current = child;
    }

    current.files = files.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Recursively compute sizes and allOrphaned, and sort children by size desc
  function computeStats(node: TreeNode): void {
    for (const child of node.children) {
      computeStats(child);
    }

    const ownFileSize = node.files.reduce((s, f) => s + f.size, 0);
    const childrenSize = node.children.reduce((s, c) => s + c.totalSize, 0);
    node.totalSize = ownFileSize + childrenSize;

    const ownFileCount = node.files.length;
    const childrenCount = node.children.reduce((s, c) => s + c.totalFileCount, 0);
    node.totalFileCount = ownFileCount + childrenCount;

    // Total size of ALL files (not just orphans) under this node
    node.folderTotalSize = totalSizeUnder(node.fullPath);

    // A leaf folder is "all orphaned" if its orphan count matches total file count
    if (node.files.length > 0 && node.children.length === 0) {
      const totalInFolder = totalPerFolder[node.fullPath] || 0;
      node.allOrphaned = node.files.length === totalInFolder;
    } else if (node.children.length > 0) {
      const ownAllOrphaned =
        node.files.length === 0 || node.files.length === (totalPerFolder[node.fullPath] || 0);
      node.allOrphaned = ownAllOrphaned && node.children.every((c) => c.allOrphaned);
    }

    // Sort children by decreasing size
    node.children.sort((a, b) => b.totalSize - a.totalSize);
  }

  computeStats(root);
  return root;
}

function collectAllPaths(node: TreeNode): string[] {
  const paths: string[] = [node.fullPath];
  for (const child of node.children) {
    paths.push(...collectAllPaths(child));
  }
  return paths;
}

function collectAllFilePaths(node: TreeNode): string[] {
  const paths = node.files.map((f) => f.path);
  for (const child of node.children) {
    paths.push(...collectAllFilePaths(child));
  }
  return paths;
}

const OrphanTree: React.FC<OrphanTreeProps> = ({
  orphans,
  allFiles,
  accountToken,
  deletedPaths,
  onMarkDeleted,
}) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sectionOpen, setSectionOpen] = useState(true);
  const [deleteMsg, setDeleteMsg] = useState('');

  const systemTree = useMemo(() => buildTree(orphans, allFiles, '/'), [orphans, allFiles]);
  const customTree = useMemo(() => buildTree(orphans, allFiles, '/custom'), [orphans, allFiles]);

  if (orphans.length === 0) {
    return (
      <div style={{ color: '#28a745', padding: '8px 0' }}>
        {intl.get('orphans.none_found').d('No orphaned assets found.')}
      </div>
    );
  }

  const isDeleted = (path: string) => deletedPaths.has(path);

  const isNodeDeleted = (node: TreeNode): boolean => {
    const allPaths = collectAllFilePaths(node);
    return allPaths.length > 0 && allPaths.every((p) => deletedPaths.has(p));
  };

  const markDeleted = (paths: string[]) => {
    onMarkDeleted(paths);
  };

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleDeleteFile = async (file: AssetFile) => {
    setDeleteMsg(intl.get('orphans.deleting_file', { name: file.name }).d('Deleting {name}...'));
    if (await deleteAsset(file.path, accountToken)) {
      showToast(intl.get('orphans.deleted_file', { name: file.name }).d('Deleted {name}'));
      markDeleted([file.path]);
    }
    setDeleteMsg('');
  };

  const handleDeleteNode = async (node: TreeNode) => {
    // The two virtual roots (`/` for "System folders", `/custom` for "Custom
    // folders") aren't real folders the SeaTable API will let you delete — even
    // if every file under them is orphaned. Force the per-file branch for
    // those, so deleting from the top of the tree iterates through children.
    const isVirtualRoot = node.fullPath === '/' || node.fullPath === '/custom';
    if (node.allOrphaned && !isVirtualRoot) {
      // Safe to delete the entire folder
      const allPaths = collectAllFilePaths(node);
      setDeleteMsg(
        intl
          .get('orphans.deleting_folder', { name: node.label, count: allPaths.length })
          .d('Deleting {count} file(s) in {name}...')
      );
      if (await deleteAsset(node.fullPath, accountToken)) {
        showToast(
          intl
            .get('orphans.deleted_folder', { name: node.label, count: allPaths.length })
            .d('Deleted {name} ({count} file(s))')
        );
        markDeleted(allPaths);
      }
      setDeleteMsg('');
    } else {
      // Not safe to delete folder — delete orphaned files individually
      const allPaths = collectAllFilePaths(node);
      let deleted = 0;
      for (let i = 0; i < allPaths.length; i++) {
        setDeleteMsg(
          intl
            .get('orphans.deleting_files_progress', {
              current: i + 1,
              total: allPaths.length,
              folder: node.label,
            })
            .d(`Deleting file ${i + 1}/${allPaths.length} in ${node.label}...`)
        );
        if (await deleteAsset(allPaths[i], accountToken)) {
          deleted++;
          markDeleted([allPaths[i]]);
        }
      }
      if (deleted > 0) {
        showToast(
          intl
            .get('orphans.deleted_files', { count: deleted, folder: node.label })
            .d(`Deleted ${deleted} file(s) in ${node.label}`)
        );
      }
      setDeleteMsg('');
    }
  };

  // Collect all expandable paths for expand/collapse all
  const allNodePaths = [...collectAllPaths(systemTree), ...collectAllPaths(customTree)];
  const allExpanded = allNodePaths.length > 0 && allNodePaths.every((p) => expanded.has(p));

  const toggleAll = () => {
    if (allExpanded) {
      setExpanded(new Set());
    } else {
      setExpanded(new Set(allNodePaths));
    }
  };

  const deletedStyle: React.CSSProperties = { textDecoration: 'line-through', opacity: 0.5 };

  const renderNode = (node: TreeNode, depth: number) => {
    if (node.totalFileCount === 0) return null;

    const isOpen = expanded.has(node.fullPath);
    const nodeDel = isNodeDeleted(node);
    const indent = depth * 20;

    return (
      <div key={node.fullPath}>
        <div
          className="asset-audit-group"
          onClick={() => toggle(node.fullPath)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 8px',
            paddingLeft: 8 + indent,
            cursor: 'pointer',
            borderRadius: 4,
            backgroundColor: 'transparent',
            ...(nodeDel ? deletedStyle : {}),
          }}>
          <i
            className={`dtable-font ${isOpen ? 'dtable-icon-down' : 'dtable-icon-right'}`}
            style={{ fontSize: 10, color: '#666' }}
          />
          <i className="dtable-font dtable-icon-folder" style={{ fontSize: 16, color: '#666' }} />
          <span style={{ fontWeight: 500 }}>{node.label}</span>
          <span style={{ color: '#888', fontSize: 12 }}>
            (
            {intl
              .get('orphans.orphaned_files', { count: node.totalFileCount })
              .d('{count} orphaned file(s)')}
            ,{' '}
            {node.folderTotalSize > 0
              ? `${fmtSize(node.totalSize)} on ${fmtSize(node.folderTotalSize)} — ${((node.totalSize / node.folderTotalSize) * 100).toFixed(0)}%`
              : fmtSize(node.totalSize)}
            )
          </span>
          {node.allOrphaned && (
            <span
              style={{
                fontSize: 11,
                color: '#ff8000',
                backgroundColor: '#e8f7fa',
                padding: '2px 6px',
                borderRadius: 3,
                marginLeft: 4,
              }}>
              {intl.get('orphans.all_orphaned').d('all orphaned -- safe to delete')}
            </span>
          )}
          {!nodeDel && (
            <span style={{ marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
              <ContextMenu
                onDelete={() => handleDeleteNode(node)}
                label={intl
                  .get('orphans.delete_files', { count: node.totalFileCount })
                  .d('Delete {count} file(s)')}
              />
            </span>
          )}
        </div>
        {isOpen && (
          <>
            {node.children.map((child) => renderNode(child, depth + 1))}
            {node.files.length > 0 && (
              <div style={{ paddingLeft: 28 + indent }}>
                {node.files.map((f) => {
                  const fileDel = isDeleted(f.path);
                  return (
                    <div
                      key={f.path}
                      className="asset-audit-row"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '3px 8px',
                        color: '#555',
                        ...(fileDel ? deletedStyle : {}),
                      }}>
                      <i
                        className="dtable-font dtable-icon-file"
                        style={{ fontSize: 14, color: '#aaa' }}
                      />
                      <span>{f.name}</span>
                      <span style={{ color: '#999', fontSize: 12 }}>({fmtSize(f.size)})</span>
                      {!fileDel && (
                        <span style={{ marginLeft: 'auto' }}>
                          <ContextMenu
                            onDelete={() => handleDeleteFile(f)}
                            label={intl.get('orphans.delete_file').d('Delete file')}
                          />
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0' }}>
        <div
          onClick={() => setSectionOpen(!sectionOpen)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
            userSelect: 'none',
            fontSize: 16,
            fontWeight: 600,
            color: '#333',
          }}>
          <i
            className={`dtable-font ${sectionOpen ? 'dtable-icon-down' : 'dtable-icon-right'}`}
            style={{ fontSize: 12 }}
          />
          {intl.get('orphans.title', { count: orphans.length }).d('Orphaned assets ({count})')}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span
            onClick={toggleAll}
            style={{ fontSize: 12, color: '#ff8000', cursor: 'pointer', userSelect: 'none' }}>
            {allExpanded
              ? intl.get('common.collapse_all').d('Collapse all')
              : intl.get('common.expand_all').d('Expand all')}
          </span>
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          padding: '8px 12px',
          marginBottom: 8,
          backgroundColor: '#fff3cd',
          border: '1px solid #ffc107',
          borderRadius: 4,
          fontSize: 13,
          color: '#664d03',
        }}>
        <i
          className="dtable-font dtable-icon-prompt"
          style={{ fontSize: 16, marginTop: 1, flexShrink: 0 }}
        />
        <span>
          {intl
            .get('orphans.delete_warning')
            .d(
              'Deleted assets cannot be recovered. Snapshots do not include files. Before deleting, consider exporting your base with the "include assets" option checked to keep a full backup. Please make sure the files listed here are no longer needed before deleting them.'
            )}
        </span>
      </div>
      {deleteMsg && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
          <div
            style={{
              width: 18,
              height: 18,
              border: '2px solid #ff8000',
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }}
          />
          <span style={{ fontSize: 13, color: '#666' }}>{deleteMsg}</span>
        </div>
      )}
      {sectionOpen && (
        <div
          style={{ fontSize: 14, ...(deleteMsg ? { pointerEvents: 'none', opacity: 0.5 } : {}) }}>
          {renderNode(systemTree, 0)}
          {renderNode(customTree, 0)}
        </div>
      )}
    </div>
  );
};

export default OrphanTree;
