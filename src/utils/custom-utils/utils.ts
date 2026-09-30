import { LINK_TYPE } from '../custom-constants/constants';
import {
  ILinksColumnData,
  ILinksData,
  ISrcFrstTblId,
  IViewPort,
  NodeResultItem,
  RelationshipState,
} from '../custom-interfaces/PluginTR';
import { PLUGIN_NAME } from '../template-constants';
import { IPluginDataStore } from '../template-interfaces/App.interface';
import { PresetCustomSettings } from '../template-interfaces/PluginPresets/Presets.interface';
import { TableArray, TableColumn } from '../template-interfaces/Table.interface';
import { MarkerType, Edge, EdgeMarker } from 'reactflow';

// Helper for Checking Data
export function isCustomSettingsFn(
  PDS: IPluginDataStore,
  allTables: TableArray,
  activePresetId: string
) {
  const activePresetCustomSettings = PDS.presets.find((preset) => preset._id === activePresetId)
    ?.customSettings;
  if (
    activePresetCustomSettings === undefined ||
    Object.keys(activePresetCustomSettings).length === 0
  ) {
    const defaultActivePresetCustomSettings = generateDefaultCustomSettings(allTables);
    return { isPDSCS: false, customSettings: defaultActivePresetCustomSettings };
  } else {
    return { isPDSCS: true, customSettings: activePresetCustomSettings };
  }
}

export function generateDefaultCustomSettings(allTables: TableArray) {
  let defaultActivePresetCustomSettings: PresetCustomSettings;
  let lnk = generateLinks(allTables);
  const ns = generateNodes(allTables);
  const es = generateEdges(lnk, ns);
  defaultActivePresetCustomSettings = {
    relationship: {
      recRel: true,
      lkRel: true,
      lk2Rel: true,
      countLinks: true,
      rollup: true,
      findmax: true,
      findmin: true,
      tblNoLnk: true,
    },
    links: lnk,
    nodes: ns,
    edges: es,
  };
  return defaultActivePresetCustomSettings;
}

export function checkNodesVsTablesIds(
  customSettings: PresetCustomSettings,
  allTablesNodes: NodeResultItem[],
  allTables: TableArray
) {
  const customNodesIds = customSettings?.nodes.map((node: NodeResultItem) => node.id);
  const allTablesIds = allTablesNodes.map((node) => node.id);
  const nodesVsTablesIds = customNodesIds.every((id: string) => allTablesIds.includes(id));
  if (nodesVsTablesIds) {
    // Even though the ids are the same, we need to check if the columns are equal
    const updatedCustomSettings = checkIfColumnsAreEqual(customSettings, allTablesNodes, allTables);
    const updatedCustomSettingsWithNodesAndColName = checkNodesNames(
      updatedCustomSettings,
      allTablesNodes
    );
    return updatedCustomSettingsWithNodesAndColName;
  }
}

export function checkIfColumnsAreEqual(
  customSettings: PresetCustomSettings,
  allTablesNodes: NodeResultItem[],
  allTables: TableArray
) {
  const customNodes = customSettings.nodes;
  const nodes = allTablesNodes;
  const _nodes: NodeResultItem[] = [...customNodes];

  const newNodes = checkColumnsPosition(nodes, _nodes);

  let _links = generateLinks(allTables);
  const _es = generateEdges(_links, newNodes);
  return { ...customSettings, links: _links, edges: _es, nodes: newNodes };
}

export function checkMissingOrExtraIds(
  customSettings: PresetCustomSettings,
  allTablesNodes: NodeResultItem[],
  allTables: TableArray
) {
  // First we need to get the ids of the nodes in the customSettings and allTables
  const customNodesIds = customSettings?.nodes.map((node: NodeResultItem) => node.id);
  const allTablesIds = allTablesNodes.map((node) => node.id);
  const missingIds = allTablesIds.filter((id) => !customNodesIds.includes(id));
  const extraIds = customNodesIds.filter((id: string) => !allTablesIds.includes(id));
  const _nodes: NodeResultItem[] = [...customSettings.nodes];
  // Add missing nodes to customSettings.nodes
  missingIds.forEach((missingId: string) => {
    const nodeToAdd = allTablesNodes.find((node) => node.id === missingId);
    if (nodeToAdd) {
      _nodes.push(nodeToAdd);
    }
  });

  // Remove extra nodes from customSettings.nodes
  extraIds.forEach((extraId: string) => {
    const nodeIndex = _nodes.findIndex((node: NodeResultItem) => node.id === extraId);
    if (nodeIndex !== -1) {
      _nodes.splice(nodeIndex, 1);
    }
  });

  let _links = generateLinks(allTables);
  const _es = generateEdges(_links, _nodes);
  return { ...customSettings, links: _links, edges: _es, nodes: _nodes };
}

export function checkNodesNames(
  customSettings: PresetCustomSettings,
  allTablesNodes: NodeResultItem[]
): PresetCustomSettings {
  const nodesMap = new Map<string, NodeResultItem>(allTablesNodes.map((node) => [node.id, node]));

  const _nodes: NodeResultItem[] = [...customSettings.nodes];

  for (let i = 0; i < _nodes.length; i++) {
    const currentNode = _nodes[i];
    const correspondingNode = nodesMap.get(currentNode.id);

    if (correspondingNode && currentNode.data.name !== correspondingNode.data.name) {
      currentNode.data.name = correspondingNode.data.name;
    }
  }

  const updatedCustomSettings = {
    ...customSettings,
    nodes: _nodes,
  };

  return updatedCustomSettings;
}

function checkColumnsPosition(
  array1: NodeResultItem[],
  array2: NodeResultItem[]
): NodeResultItem[] {
  // Create a new array to store the merged results
  const mergedArray: NodeResultItem[] = [];

  for (let i = 0; i < array1.length; i++) {
    const item1 = array1[i];
    const item2 = array2.find((item) => item.id === item1.id);

    if (item2) {
      // Compare and merge columns
      const mergedColumns = item1.data.columns.map((col, index) => {
        const col2 = item2.data.columns[index];
        if (JSON.stringify(col) !== JSON.stringify(col2)) {
          return col;
        }
        return col2;
      });

      // Create merged item
      const mergedItem: NodeResultItem = {
        ...item2,
        data: {
          ...item2.data,
          columns: mergedColumns,
        },
      };

      mergedArray.push(mergedItem);
    }
  }

  return mergedArray;
}

// This function is used to update the customSettings in the PluginDataStore
export function setPluginDataStoreFn(
  pluginDataStore: IPluginDataStore,
  activeRelationships: RelationshipState,
  activePresetId: string,
  ns: any[],
  lnk: ILinksData[],
  es: Edge[]
) {
  window.dtableSDK.updatePluginSettings(PLUGIN_NAME, {
    ...pluginDataStore,
    presets: pluginDataStore.presets.map((preset) => {
      if (preset._id === activePresetId) {
        return {
          ...preset,
          customSettings: {
            ...preset.customSettings,
            nodes: ns,
            links: lnk,
            edges: es,
            relationship: activeRelationships,
          },
        };
      }
      return preset;
    }),
  });
}

export function setViewportPluginDataStoreFn(
  pluginDataStore: IPluginDataStore,
  activePresetId: string,
  vp: IViewPort
) {
  window.dtableSDK.updatePluginSettings(PLUGIN_NAME, {
    ...pluginDataStore,
    presets: pluginDataStore.presets.map((preset) => {
      if (preset._id === activePresetId) {
        return {
          ...preset,
          customSettings: {
            ...preset.customSettings,
            vp: vp,
          },
        };
      }
      return preset;
    }),
  });
}

export function generateLinks(allTables: TableArray): ILinksData[] {
  const formulaCc: TableColumn[] = []; // Column 'link' type
  const linkCc: ILinksColumnData[] = []; // Column 'link-formula' type

  allTables.forEach((t) => {
    t.columns.forEach((c) => {
      if (c.type === LINK_TYPE.link) {
        linkCc.push({
          table_id: t._id,
          table_name: t.name,
          column_key: c.key,
          column_name: c.name,
          srcT: c.data.table_id,
          tgtT: c.data.other_table_id,
          link_id: c.data.link_id,
          isMultiple: c.data.is_multiple,
        });
      } else if (c.type === LINK_TYPE.formula) {
        formulaCc.push(c);
      }
    });
  });

  const lCcData: ILinksData[] = reduceLinkCcData(linkCc); // Column 'link' Data for Link
  const fCcData: ILinksData[] = createFormulaCcData(formulaCc, allTables); // Column 'link-formula' Data for Link

  return [...lCcData, ...fCcData];
}

export function filterRelationshipLinks(lnk: ILinksData[], relationship: RelationshipState) {
  if (!relationship.recRel) {
    lnk = lnk.filter((obj) => obj.type !== LINK_TYPE.link);
  }
  if (!relationship.lkRel) {
    lnk = lnk.filter((obj) => obj.formulaType !== LINK_TYPE.lookup);
  }
  if (!relationship.countLinks) {
    lnk = lnk.filter((obj) => obj.formulaType !== LINK_TYPE.countLinks);
  }
  if (!relationship.rollup) {
    lnk = lnk.filter((obj) => obj.formulaType !== LINK_TYPE.rollup);
  }
  if (!relationship.findmax) {
    lnk = lnk.filter((obj) => obj.formulaType !== LINK_TYPE.findmax);
  }
  if (!relationship.findmin) {
    lnk = lnk.filter((obj) => obj.formulaType !== LINK_TYPE.findmin);
  }
  return lnk;
}

export function filterNodesWithoutLinks(nodes: any[]) {
  return nodes.filter((n) => n.data.columns.some((c: any) => c.type === LINK_TYPE.link));
}

export function generateNodes(allTables: TableArray): NodeResultItem[] {
  const numRows: number = 5;
  const numCols: number = 5;

  const ns: NodeResultItem[] = [];

  for (let i = 0; i < allTables.length; i++) {
    const table = allTables[i];
    const info = table.columns.map((cl) => ({
      key: cl.key,
      type: cl.type,
      name: cl.name,
      isMultiple: cl.data === undefined || cl.data === null ? false : cl.data.is_multiple,
    }));

    // Calculate position
    const rowIndex = Math.floor(i / numCols);
    const colIndex = i % numCols;
    const x = 100 + colIndex * 250;
    const y = 100 + rowIndex * 250;

    const activeNode: NodeResultItem = {
      id: table._id.toString(),
      type: 'custom',
      position: { x, y },
      data: {
        name: table.name.toString(),
        columns: info,
        position: { x, y },
      },
    };

    ns.push(activeNode);
  }

  return ns;
}

export function generateEdges(links: ILinksData[], ns: NodeResultItem[]): Edge[] {
  const es: Edge[] = [];
  let sourceHandle = '';
  let targetHandle = '';
  links.forEach((link, index) => {
    const { sourceData, targetData1st, type } = link;
    if (sourceData === null || targetData1st === null) {
      return;
    }
    const sourceTbl = sourceData.table_id;
    const targetTbl = targetData1st.table_id;
    const pointSameTable = sourceTbl === targetTbl;
    const sourceNode = ns.find((n) => n.id === sourceTbl);
    const targetNode = ns.find((n) => n.id === targetTbl);

    let lineStyle: any;
    const lineStylesOptions = {
      link: {
        strokeDasharray: '0',
      },
      formula: {
        strokeDasharray: '5 3',
      },
      formula2nd: {
        strokeDasharray: '1 5',
      },
    };

    switch (type) {
      case LINK_TYPE.link:
        lineStyle = lineStylesOptions.link;
        break;
      case LINK_TYPE.formula:
        lineStyle = lineStylesOptions.formula;
        break;
      case LINK_TYPE.formula2nd:
        lineStyle = lineStylesOptions.formula2nd;
        break;
      default:
        lineStyle = lineStylesOptions.link;

        break;
    }

    if (sourceNode && targetNode) {
      let src = {
        tId: sourceNode.id,
        cId: sourceData.column_key,
        edgSide: sourceNode.position.x > targetNode.position.x ? 'l' : 'r',
        suffix: '-src',
      };
      let tgt = {
        tId: targetNode.id,
        cId: targetData1st.column_key,
        edgSide: sourceNode.position.x < targetNode.position.x ? 'l' : 'r',
        suffix: '-tgt',
      };

      //console.log('src', src);
      //console.log('tgt', tgt);

      // show self-linkage other side:
      if (tgt.cId === tgt.tId) {
        tgt.edgSide = 'l';
        src.edgSide = 'l';
      }

      sourceHandle = `${src.tId}_${src.cId}_${src.edgSide}${src.suffix}`;
      targetHandle = `${tgt.tId}_${tgt.cId}_${tgt.edgSide}${tgt.suffix}`;
    }

    const markerType: EdgeMarker = {
      type: MarkerType.ArrowClosed,
      width: 10,
      height: 10,
      color: '#212529',
    };

    if (sourceTbl && targetTbl) {
      es.push({
        id: String(es.length),
        source: sourceTbl,
        target: targetTbl,
        sourceHandle: sourceHandle,
        targetHandle: targetHandle,
        type: !pointSameTable ? 'simplebezier' : 'smoothstep',
        style: {
          strokeWidth: 1,
          stroke: '#212529',
          strokeDasharray: lineStyle.strokeDasharray,
        },
        markerStart: type === LINK_TYPE.link ? markerType : '',
        markerEnd: markerType,
      });
    }
  });

  return es;
}

// Helper for generateLinks
// Finding the data for the source and target of the link
function findData(
  formulaTye: string,
  tableKey: string,
  columnKey: string,
  allTables: TableArray,
  sourceTarget?: string
) {
  let result: ILinksColumnData = {
    column_key: '',
    column_name: '',
    table_id: '',
    table_name: '',
    isMultiple: true,
  };
  allTables.forEach((t) => {
    if (t._id === tableKey) {
      t?.columns.forEach((c: TableColumn) => {
        if (c.key === columnKey) {
          result = {
            column_key: c.key,
            column_name: c.name,
            table_id: t._id,
            table_name: t.name,
            isMultiple: c.type === LINK_TYPE.link ? c.data.is_multiple : false,
          };
        }
      });
    }
  });

  return result;
}

function findSourceAndFirstLinkedTableId(key: string, allTables: TableArray) {
  let result: ISrcFrstTblId = { firstLinkTableId: '', sourceTableId: '' };
  allTables.forEach((t) => {
    t.columns.forEach((c) => {
      if (c.key === key && c.type === LINK_TYPE.link) {
        result = {
          firstLinkTableId:
            c.data.other_table_id === t._id ? c.data.table_id : c.data.other_table_id,
          sourceTableId: c.data.table_id === t._id ? c.data.table_id : c.data.other_table_id,
        };
      }
    });
  });

  return result;
}

function findSecondLinkedTableId(tableKey: string, columnKey: string, allTables: TableArray) {
  let targetColumns: TableColumn[] = [];
  let result: string = '';
  let tId = '';
  allTables.forEach((t) => {
    if (t._id === tableKey) {
      tId = t._id;
      targetColumns = t.columns;
    }
  });

  targetColumns?.forEach((c: TableColumn) => {
    if (c.key === columnKey && c.type === LINK_TYPE.link) {
      result = c.data.other_table_id === tId ? c.data.table_id : c.data.other_table_id;
    }
  });

  return result;
}

function reduceLinkCcData(linkCc: ILinksColumnData[]) {
  const groupedItems: {
    [key: string]: { sourceData: ILinksColumnData | null; targetData: ILinksColumnData | null };
  } = {};
  linkCc.forEach((item) => {
    // create groupedItem element with sourceData and targetData: null
    if (item.link_id && !groupedItems[item.link_id]) {
      groupedItems[item.link_id] = { sourceData: null, targetData: null };
    }

    // to support self-linkage with v5.2
    if (
      item.link_id &&
      item.table_id === item.srcT &&
      groupedItems[item.link_id].sourceData !== null
    ) {
      groupedItems[item.link_id].targetData = item;
    } else if (item.link_id && item.table_id === item.srcT) {
      groupedItems[item.link_id].sourceData = item;
    } else if (item.link_id && item.table_id === item.tgtT) {
      groupedItems[item.link_id].targetData = item;
    }
  });

  let filteredData: {
    [linkId: string]: {
      sourceData: ILinksColumnData;
      targetData: ILinksColumnData;
    };
  } = {};

  for (let key in groupedItems) {
    if (Object.prototype.hasOwnProperty.call(groupedItems, key)) {
      filteredData[key] = {
        sourceData: groupedItems[key].sourceData!,
        targetData: groupedItems[key].targetData!,
      };
    }
  }

  const filteredDataResult = Object.values(filteredData).map(
    (g: { sourceData: ILinksColumnData; targetData: ILinksColumnData }) => {
      return {
        type: LINK_TYPE.link,
        sourceData: g.sourceData,
        targetData1st: g.targetData,
      };
    }
  );

  return removeUndefinedOrNull(filteredDataResult);
}

function removeUndefinedOrNull(
  arr: {
    type: string;
    sourceData: ILinksColumnData;
    targetData1st: ILinksColumnData;
  }[]
) {
  return arr.filter(
    (obj) =>
      obj.sourceData !== undefined &&
      obj.sourceData !== null &&
      obj.targetData1st !== undefined &&
      obj.targetData1st !== null
  );
}
function createFormulaCcData(data: TableColumn[], allTables: TableArray) {
  let fCcData: ILinksData[] = [];

  const fCcRowData = data.map((fc: TableColumn) => {
    let secondLinkedTableId: string | undefined;
    const { sourceTableId, firstLinkTableId } = findSourceAndFirstLinkedTableId(
      fc.data.link_column_key,
      allTables
    );

    if (firstLinkTableId && fc.data.level2_linked_table_column_key) {
      secondLinkedTableId = findSecondLinkedTableId(
        firstLinkTableId,
        fc.data.level1_linked_table_column_key,
        allTables
      );
    }

    if (fc.data.level2_linked_table_column_key) {
      const targetTableKey =
        fc.data.formula === LINK_TYPE.findmax || fc.data.formula === LINK_TYPE.findmin
          ? sourceTableId
          : firstLinkTableId;
      const targetFirstColumnKey =
        fc.data.formula === LINK_TYPE.findmax || fc.data.formula === LINK_TYPE.findmin
          ? fc.data.level2_linked_table_column_key
          : fc.data.level1_linked_table_column_key;
      return {
        type: fc.type,
        formulaType: fc.data.formula,
        sourceData: findData(fc.data.formula, sourceTableId, fc.key, allTables, 'source'),
        targetData1st: findData(
          fc.data.formula,
          targetTableKey,
          targetFirstColumnKey,
          allTables,
          'target 1'
        ),
        targetData2nd: findData(
          fc.data.formula,
          secondLinkedTableId!,
          fc.data.level2_linked_table_column_key,
          allTables,
          'target 2'
        ),
      };
    } else {
      const targetTableKey =
        fc.data.formula === LINK_TYPE.countLinks ? sourceTableId : firstLinkTableId;
      return {
        type: fc.type,
        formulaType: fc.data.formula,
        sourceData: findData(fc.data.formula, sourceTableId, fc.key, allTables, 'source'),
        targetData1st: findData(
          fc.data.formula,
          targetTableKey,
          fc.data.level1_linked_table_column_key ||
            fc.data.column_key_in_linked_record ||
            fc.data.link_column_key ||
            fc.data.column_key_for_comparison,
          allTables,
          'target'
        ),
      };
    }
  });

  fCcRowData.forEach((fc: ILinksData) => {
    fCcData.push({
      formulaType: fc.formulaType,
      type: fc.targetData2nd ? LINK_TYPE.formula2nd : LINK_TYPE.formula,
      sourceData: fc.sourceData,
      targetData1st: fc.targetData1st,
    });

    if (fc.targetData2nd) {
      fCcData.push({
        formulaType: fc.formulaType,
        type: LINK_TYPE.formula2nd,
        sourceData: fc.targetData1st,
        targetData1st: fc.targetData2nd,
      });
    }
  });
  fCcData = fCcData.filter(
    (i: ILinksData) =>
      Object.prototype.hasOwnProperty.call(i, 'sourceData') && i.sourceData !== undefined
  );

  return fCcData;
}
