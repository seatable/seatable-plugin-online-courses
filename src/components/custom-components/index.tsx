import React, { useEffect, useMemo, useRef, useCallback } from 'react';
import intl from 'react-intl-universal';
import { IPluginTRProps } from '../../utils/custom-interfaces/PluginTR';
import { AssetsAuditResult } from '../../utils/custom-interfaces/AuditTypes';
import { TableColorContext, buildTableColorMap, extractLinkAdjacency } from './shared/tablePalette';
import {
  PRESET_ASSETS_AUDIT,
  PRESET_TABLES_AUDIT,
  PRESET_LINKS_AUDIT,
} from '../../utils/custom-constants/constants';
import { PLUGIN_NAME } from '../../utils/template-constants';
import { showToast } from './shared/showToast';
import { createSnapshot } from './shared/createSnapshot';
import AssetsAudit from './AssetsAudit';
import TablesAudit from './TablesAudit';
import LinksAudit from './LinksAudit';
import styles from '../../styles/custom-styles/PluginTR.module.scss';
import '../../styles/custom-styles/overview.css';

const CustomPlugin: React.FC<IPluginTRProps> = ({
  appActiveState,
  allTables,
  pluginDataStore,
  verifyUrls,
  auditTableDisplay,
  autoRerun,
  onPerfRunningChange,
}) => {
  const initialized = useRef(false);
  const snapshotDone = useRef(false);

  // Color assignment for chain-graph table labels — built once from the full
  // base link structure so directly link-adjacent tables get distinct colors
  // (Welsh-Powell greedy graph coloring up to the 8-color palette).
  const tableColorMap = useMemo(() => {
    const adjacency = extractLinkAdjacency(allTables);
    const names = allTables.map((t: any) => t.name).filter(Boolean);
    return buildTableColorMap(adjacency, names);
  }, [allTables]);

  // Create a snapshot as backup each time the plugin is opened
  useEffect(() => {
    if (snapshotDone.current) return;
    snapshotDone.current = true;
    createSnapshot().then((ok) => {
      if (ok) showToast(intl.get('snapshot.created').d('Snapshot created before audit'));
    });
  }, []);

  // On first mount, replace the default "New chart" preset with our two audit presets
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const presets = pluginDataStore.presets || [];
    const hasAssetsPreset = presets.some((p) => p.name.toLowerCase().includes('asset'));
    const hasTablesPreset = presets.some((p) => p.name.toLowerCase().includes('table'));
    const hasLinksPreset = presets.some((p) => p.name.toLowerCase().includes('link'));
    // Legacy: earlier versions seeded a standalone "Performance audit" preset. The
    // performance analysis is now an in-tab feature of Tables audit, so we drop any
    // such preset we find.
    const hasLegacyPerformancePreset = presets.some((p) =>
      p.name.toLowerCase().includes('performance')
    );

    const needsSeed = !hasAssetsPreset || !hasTablesPreset || !hasLinksPreset;
    const needsMigration = hasLegacyPerformancePreset;

    if (needsSeed || needsMigration) {
      const defaultTable =
        allTables.length > 0
          ? { value: allTables[0]._id, label: allTables[0].name }
          : { value: '', label: '' };
      const defaultView =
        allTables.length > 0 && allTables[0].views?.length > 0
          ? { value: allTables[0].views[0]._id, label: allTables[0].views[0].name }
          : { value: '', label: '' };

      const defaultSettings = {
        selectedTable: defaultTable,
        selectedView: defaultView,
      };

      // When seeding from empty, create the three audit presets. When migrating (e.g.
      // removing the legacy Performance audit preset), preserve every existing preset
      // except the performance one so user-customized presets survive.
      const newPresets = needsSeed
        ? [
            { _id: 'aud1', name: PRESET_ASSETS_AUDIT, settings: { ...defaultSettings } },
            { _id: 'aud2', name: PRESET_TABLES_AUDIT, settings: { ...defaultSettings } },
            { _id: 'aud3', name: PRESET_LINKS_AUDIT, settings: { ...defaultSettings } },
          ]
        : presets.filter((p) => !p.name.toLowerCase().includes('performance'));

      const activeIdx = pluginDataStore.activePresetIdx ?? 0;
      const activeWasPerformance = (presets[activeIdx]?.name || '')
        .toLowerCase()
        .includes('performance');

      const updatedStore = {
        ...pluginDataStore,
        activePresetId: activeWasPerformance
          ? newPresets[0]?._id || 'aud1'
          : pluginDataStore.activePresetId,
        activePresetIdx: activeWasPerformance ? 0 : activeIdx,
        presets: newPresets,
      };

      (window as any).dtableSDK.updatePluginSettings(PLUGIN_NAME, updatedStore);
    }
  }, [allTables, pluginDataStore]);

  // Determine which audit view to show based on the active preset name
  const activePreset =
    pluginDataStore.presets?.[appActiveState.activePresetIdx] || pluginDataStore.presets?.[0];
  const presetName = activePreset?.name || '';

  const isTablesAudit = presetName.toLowerCase().includes('table');
  const isLinksAudit = presetName.toLowerCase().includes('link');
  const accountToken = pluginDataStore.accountToken || '';
  const rerunAt = activePreset?.customSettings?.rerunAt;
  const presetId = activePreset?._id || '';
  const savedAudit = activePreset?.customSettings?.savedAudit || null;
  const savedTablesAudit = activePreset?.customSettings?.savedTablesAudit || null;
  const savedLinksAudit = activePreset?.customSettings?.savedLinksAudit || null;
  const savedPerformanceAudit = activePreset?.customSettings?.savedPerformanceAudit || null;

  const handleSaveToStore = useCallback(
    (key: string, data: any) => {
      try {
        const currentData =
          (window as any).dtableSDK.getPluginSettings(PLUGIN_NAME) || pluginDataStore;
        const updatedPresets = (currentData.presets || []).map((preset: any) =>
          preset._id === presetId
            ? { ...preset, customSettings: { ...preset.customSettings, [key]: data } }
            : preset
        );
        (window as any).dtableSDK.updatePluginSettings(PLUGIN_NAME, {
          ...currentData,
          presets: updatedPresets,
        });
      } catch (err) {
        console.error('Failed to persist audit:', err);
      }
    },
    [presetId, pluginDataStore]
  );

  const handleSaveAudit = useCallback(
    (data: { result: AssetsAuditResult; date: string; deletedPaths?: string[] }) =>
      handleSaveToStore('savedAudit', data),
    [handleSaveToStore]
  );

  const handleSaveTablesAudit = useCallback(
    (data: any) => handleSaveToStore('savedTablesAudit', data),
    [handleSaveToStore]
  );

  const handleSaveLinksAudit = useCallback(
    (data: any) => handleSaveToStore('savedLinksAudit', data),
    [handleSaveToStore]
  );

  const handleSavePerformanceAudit = useCallback(
    (data: any) => handleSaveToStore('savedPerformanceAudit', data),
    [handleSaveToStore]
  );

  return (
    <TableColorContext.Provider value={tableColorMap}>
      <div className={styles.custom}>
        {isLinksAudit ? (
          <LinksAudit
            presetId={presetId}
            rerunAt={rerunAt}
            autoRerun={autoRerun}
            savedAudit={!autoRerun ? savedLinksAudit : null}
            onSaveAudit={!autoRerun ? handleSaveLinksAudit : undefined}
          />
        ) : isTablesAudit ? (
          // Unified Tables audit: fast structural audit on the table tabs,
          // on-demand Performance analysis as a virtual tab.
          <TablesAudit
            presetId={presetId}
            rerunAt={rerunAt}
            auditTableDisplay={auditTableDisplay}
            autoRerun={autoRerun}
            savedAudit={!autoRerun ? savedTablesAudit : null}
            onSaveAudit={!autoRerun ? handleSaveTablesAudit : undefined}
            accountToken={accountToken}
            savedPerformanceAudit={savedPerformanceAudit}
            onSavePerformanceAudit={handleSavePerformanceAudit}
            onPerfRunningChange={onPerfRunningChange}
          />
        ) : (
          <AssetsAudit
            accountToken={accountToken}
            presetId={presetId}
            rerunAt={rerunAt}
            verifyUrls={verifyUrls}
            savedAudit={savedAudit}
            onSaveAudit={handleSaveAudit}
          />
        )}
      </div>
    </TableColorContext.Provider>
  );
};

export default CustomPlugin;
