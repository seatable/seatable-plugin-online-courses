import React, { useState, useMemo, useCallback } from 'react';
import intl from 'react-intl-universal';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { AssetFile } from '../../../utils/custom-interfaces/AuditTypes';
import { ORPHAN_EXCLUDE_PREFIXES } from '../../../utils/custom-constants/constants';
import { fmtSize } from '../../../utils/custom-utils/formatters';

interface StorageChartProps {
  allFiles: AssetFile[];
}

interface SliceData {
  label: string;
  fullPath: string;
  size: number;
  fileCount: number;
  percentage: number;
  isSystemFolder: boolean;
  isFolder: boolean;
  hasChildren: boolean;
}

const COLORS = [
  '#0088FE',
  '#00C49F',
  '#FFBB28',
  '#FF8042',
  '#8884d8',
  '#82ca9d',
  '#ffc658',
  '#d0ed57',
  '#a4de6c',
  '#8dd1e1',
  '#83a6ed',
  '#8a8a8a',
];

// Sentinel path for "System folders" (all non-custom files under /)
const SYSTEM_PATH = '/__system__';

function isSystemView(path: string) {
  return path === SYSTEM_PATH;
}

function getFilesForPath(allFiles: AssetFile[], currentPath: string): AssetFile[] {
  if (currentPath === '/') return allFiles;
  if (isSystemView(currentPath)) return allFiles.filter((f) => !f.folder.startsWith('/custom'));
  return allFiles.filter((f) => f.folder.startsWith(currentPath));
}

function computeSlices(allFiles: AssetFile[], currentPath: string): SliceData[] {
  // Root level: show two top-level groups
  if (currentPath === '/') {
    const systemFiles = allFiles.filter((f) => !f.folder.startsWith('/custom'));
    const customFiles = allFiles.filter((f) => f.folder.startsWith('/custom'));
    const totalSize = allFiles.reduce((s, f) => s + f.size, 0);
    if (totalSize === 0) return [];

    const slices: SliceData[] = [];
    if (systemFiles.length > 0) {
      const size = systemFiles.reduce((s, f) => s + f.size, 0);
      slices.push({
        label: intl.get('orphans.system_folders').d('System folders'),
        fullPath: SYSTEM_PATH,
        size,
        fileCount: systemFiles.length,
        percentage: size / totalSize,
        isSystemFolder: false,
        isFolder: true,
        hasChildren: true,
      });
    }
    if (customFiles.length > 0) {
      const size = customFiles.reduce((s, f) => s + f.size, 0);
      slices.push({
        label: intl.get('orphans.custom_folders').d('Custom folders'),
        fullPath: '/custom',
        size,
        fileCount: customFiles.length,
        percentage: size / totalSize,
        isSystemFolder: false,
        isFolder: true,
        hasChildren: true,
      });
    }
    return slices.sort((a, b) => b.size - a.size);
  }

  const filesUnder = getFilesForPath(allFiles, currentPath);
  const totalSize = filesUnder.reduce((s, f) => s + f.size, 0);
  if (totalSize === 0) return [];

  // For system view, group by first folder segment; otherwise relative to currentPath
  const groups: Record<string, { size: number; count: number; hasDeeper: boolean }> = {};
  const rootFiles: AssetFile[] = [];

  for (const f of filesUnder) {
    const relative = isSystemView(currentPath) ? f.folder : f.folder.slice(currentPath.length);
    const parts = relative.replace(/^\//, '').split('/').filter(Boolean);

    if (parts.length === 0) {
      rootFiles.push(f);
    } else {
      const nextSegment = parts[0];
      if (!groups[nextSegment]) groups[nextSegment] = { size: 0, count: 0, hasDeeper: false };
      groups[nextSegment].size += f.size;
      groups[nextSegment].count += 1;
      if (parts.length > 1) groups[nextSegment].hasDeeper = true;
    }
  }

  const slices: SliceData[] = [];

  for (const [segment, data] of Object.entries(groups)) {
    const fullPath = isSystemView(currentPath) ? '/' + segment : currentPath + '/' + segment;
    slices.push({
      label: segment,
      fullPath,
      size: data.size,
      fileCount: data.count,
      percentage: totalSize > 0 ? data.size / totalSize : 0,
      isSystemFolder: ORPHAN_EXCLUDE_PREFIXES.some(
        (prefix) => fullPath === prefix || prefix.startsWith(fullPath + '/')
      ),
      isFolder: true,
      hasChildren: true,
    });
  }

  for (const f of rootFiles) {
    slices.push({
      label: f.name,
      fullPath: f.path,
      size: f.size,
      fileCount: 1,
      percentage: totalSize > 0 ? f.size / totalSize : 0,
      isSystemFolder: false,
      isFolder: false,
      hasChildren: false,
    });
  }

  const sorted = slices.sort((a, b) => b.size - a.size);

  // Cap at 10 slices — group the rest into "Other"
  const MAX_SLICES = 10;
  if (sorted.length <= MAX_SLICES) return sorted;

  const kept = sorted.slice(0, MAX_SLICES);
  const rest = sorted.slice(MAX_SLICES);
  const otherSize = rest.reduce((s, r) => s + r.size, 0);
  const otherCount = rest.reduce((s, r) => s + r.fileCount, 0);
  kept.push({
    label: intl.get('chart.other', { count: rest.length }).d('Other ({count})'),
    fullPath: '',
    size: otherSize,
    fileCount: otherCount,
    percentage: totalSize > 0 ? otherSize / totalSize : 0,
    isSystemFolder: false,
    isFolder: false,
    hasChildren: false,
  });
  return kept;
}

const CustomTooltip = ({ active, payload }: any) => {
  if (!active || !payload || !payload.length) return null;
  const data = payload[0].payload as SliceData;
  return (
    <div
      style={{
        backgroundColor: '#fff',
        border: '1px solid #ddd',
        borderRadius: 4,
        padding: '8px 12px',
        fontSize: 13,
      }}>
      <div style={{ fontWeight: 600 }}>
        {data.fullPath === SYSTEM_PATH
          ? `${intl.get('orphans.system_folders').d('System folders')} (/)`
          : data.fullPath}
      </div>
      <div>{fmtSize(data.size)}</div>
      {data.isFolder && (
        <div>{intl.get('chart.file_count', { count: data.fileCount }).d('{count} file(s)')}</div>
      )}
      <div>{(data.percentage * 100).toFixed(1)}%</div>
      {data.isSystemFolder && (
        <div style={{ color: '#dc3545', marginTop: 4 }}>
          {intl.get('chart.system_folder_warning').d('System folder - DO NOT DELETE')}
        </div>
      )}
      {data.hasChildren && (
        <div style={{ color: '#ff8000', marginTop: 4 }}>
          {intl.get('chart.click_to_drill').d('Click to drill down')}
        </div>
      )}
    </div>
  );
};

const StorageChart: React.FC<StorageChartProps> = ({ allFiles }) => {
  const [currentPath, setCurrentPath] = useState('/');

  const slices = useMemo(() => computeSlices(allFiles, currentPath), [allFiles, currentPath]);

  const goUp = useCallback(() => {
    if (currentPath === '/') return;
    if (isSystemView(currentPath) || currentPath === '/custom') {
      setCurrentPath('/');
      return;
    }
    const parentEnd = currentPath.lastIndexOf('/');
    const parent = parentEnd <= 0 ? '/' : currentPath.slice(0, parentEnd);
    // If parent is / and the current path was not under /custom, go to system view
    if (parent === '/' && !currentPath.startsWith('/custom')) {
      setCurrentPath(SYSTEM_PATH);
    } else {
      setCurrentPath(parent);
    }
  }, [currentPath]);

  if (allFiles.length === 0) return null;

  // Build breadcrumb
  const breadcrumbs: { label: string; path: string; isLast: boolean }[] = [];

  const labelAll = intl.get('chart.all').d('All');
  const labelSystem = intl.get('orphans.system_folders').d('System folders');
  const labelCustom = intl.get('orphans.custom_folders').d('Custom folders');

  if (currentPath === '/') {
    breadcrumbs.push({ label: labelAll, path: '/', isLast: true });
  } else if (isSystemView(currentPath)) {
    breadcrumbs.push({ label: labelAll, path: '/', isLast: false });
    breadcrumbs.push({ label: labelSystem, path: SYSTEM_PATH, isLast: true });
  } else if (currentPath.startsWith('/custom')) {
    breadcrumbs.push({ label: labelAll, path: '/', isLast: false });
    breadcrumbs.push({ label: labelCustom, path: '/custom', isLast: currentPath === '/custom' });
    if (currentPath !== '/custom') {
      const rest = currentPath.slice('/custom'.length).replace(/^\//, '').split('/');
      let built = '/custom';
      for (let i = 0; i < rest.length; i++) {
        built += '/' + rest[i];
        breadcrumbs.push({ label: rest[i], path: built, isLast: i === rest.length - 1 });
      }
    }
  } else {
    // Under system folders: All > System folders > ...segments
    breadcrumbs.push({ label: labelAll, path: '/', isLast: false });
    breadcrumbs.push({ label: labelSystem, path: SYSTEM_PATH, isLast: false });
    const parts = currentPath.replace(/^\//, '').split('/');
    let built = '';
    for (let i = 0; i < parts.length; i++) {
      built += '/' + parts[i];
      breadcrumbs.push({ label: parts[i], path: built, isLast: i === parts.length - 1 });
    }
  }

  const handleSliceClick = (_: any, index: number) => {
    const slice = slices[index];
    if (slice && slice.hasChildren) {
      setCurrentPath(slice.fullPath);
    }
  };

  return (
    <div style={{ marginBottom: 8 }}>
      {/* Breadcrumb */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 13,
          marginBottom: 8,
          flexWrap: 'wrap',
        }}>
        {breadcrumbs.map((crumb, i) => (
          <React.Fragment key={crumb.path}>
            {i > 0 && <span style={{ color: '#999' }}>&gt;</span>}
            <span
              onClick={() => !crumb.isLast && setCurrentPath(crumb.path)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                cursor: crumb.isLast ? 'default' : 'pointer',
                color: '#333',
                fontWeight: crumb.isLast ? 600 : 400,
              }}>
              <i className="dtable-font dtable-icon-folder" style={{ fontSize: 14 }} />
              {crumb.label}
            </span>
          </React.Fragment>
        ))}
      </div>

      {slices.length === 0 ? (
        <div style={{ color: '#888', padding: '16px 0' }}>
          {intl.get('chart.no_files').d('No files in this folder.')}
        </div>
      ) : (
        <div
          style={{
            width: '100%',
            height: 350,
            cursor: currentPath !== '/' ? 'pointer' : 'default',
          }}
          onClick={goUp}>
          <ResponsiveContainer>
            <PieChart>
              <Pie
                data={slices}
                dataKey="size"
                nameKey="label"
                cx="50%"
                cy="50%"
                outerRadius={120}
                animationDuration={300}
                onClick={(_, index, e) => {
                  e.stopPropagation();
                  handleSliceClick(_, index);
                }}
                style={{ cursor: 'pointer' }}
                label={({ label, percentage, x, y, cx }: any) => {
                  if (percentage < 0.02) return null;
                  return (
                    <text
                      x={x}
                      y={y}
                      textAnchor={x > cx ? 'start' : 'end'}
                      dominantBaseline="central"
                      fontSize={12}
                      fill="#333">
                      {`${label} (${(percentage * 100).toFixed(1)}%)`}
                    </text>
                  );
                }}
                labelLine={({ points, percentage }: any) => {
                  if (percentage < 0.02) return <line stroke="none" />;
                  return (
                    <line
                      x1={points[0].x}
                      y1={points[0].y}
                      x2={points[1].x}
                      y2={points[1].y}
                      stroke="#999"
                      strokeWidth={1}
                    />
                  );
                }}>
                {slices.map((entry, i) => (
                  <Cell
                    key={entry.fullPath}
                    fill={entry.isSystemFolder ? '#aaa' : COLORS[i % COLORS.length]}
                    stroke="#fff"
                    strokeWidth={2}
                    style={{ cursor: entry.hasChildren ? 'pointer' : 'default' }}
                  />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
};

export default StorageChart;
