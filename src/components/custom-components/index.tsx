/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useCallback, useState, useRef } from 'react';
import ReactFlow, {
  useNodesState,
  useEdgesState,
  isNode,
  useViewport,
  useReactFlow,
  Viewport,
} from 'reactflow';
import {
  IPluginTRProps,
  ILinksData,
  INodePositions,
  NodeResultItem,
  RelationshipState,
  nodeCts,
} from '../../utils/custom-interfaces/PluginTR';
import CustomNode from './NodesComponent/CustomNode';

// Import styles once
import 'reactflow/dist/style.css';
import '../../styles/custom-styles/overview.css';

// Import utils
import {
  generateNodes,
  isCustomSettingsFn,
  setPluginDataStoreFn,
  checkMissingOrExtraIds,
  checkNodesVsTablesIds,
  filterRelationshipLinks,
  filterNodesWithoutLinks,
  generateEdges,
  generateLinks,
  setViewportPluginDataStoreFn,
} from '../../utils/custom-utils/utils';

import { TableArray } from '../../utils/template-interfaces/Table.interface';
import {
  IPresetInfo,
  PresetCustomSettings,
} from '../../utils/template-interfaces/PluginPresets/Presets.interface';
import { IPluginDataStore } from '../../utils/template-interfaces/App.interface';

const nodeTypes = {
  custom: CustomNode,
};
// Plugin Table Relationships Component
const PluginTR: React.FC<IPluginTRProps> = ({
  appActiveState,
  allTables,
  pluginDataStore,
  activeRelationships,
}) => {
  const [_allTables, setAllTables] = useState<TableArray>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [links, setLinks] = useState<ILinksData[]>([]);
  const [nodesCts, setNodesCts] = useState<nodeCts[]>([]);
  const [relationship, setRelationship] = useState(activeRelationships);
  const [prevNodePositions, setPrevNodePositions]: [
    INodePositions,
    React.Dispatch<React.SetStateAction<INodePositions>>,
  ] = useState({});
  const viewPortState = useViewport();
  const reactFlow = useReactFlow();

  const [_pluginVPDataStore, setPluginVPDataStore] = useState(viewPortState);
  let activeCustomSettings: PresetCustomSettings;

  useEffect(() => {
    let _edges = edges;
    let _links = generateLinks(allTables);

    const pluginPresetData =
      pluginDataStore.presets[
        pluginDataStore.presets.findIndex(
          (preset: IPresetInfo) => preset._id === appActiveState.activePresetId
        )
      ];
    const cs = pluginPresetData?.customSettings;
    //   // no need to set relationship state if there's no change (precautionary measure for infinite loop)
    if (JSON.stringify(activeRelationships) !== JSON.stringify(relationship)) {
      setRelationship(activeRelationships);
    }
    // Filtering the links based on the active relationships
    const filteredLinks = filterRelationshipLinks(_links, activeRelationships);

    // Filtering the nodes based on the active relationships
    const nodesNoLinks =
      activeRelationships.tblNoLnk === false ? filterNodesWithoutLinks(nodes) : cs?.nodes;

    // Further filtering the nodes to remove any nodes without a type
    const validNodes =
      nodesNoLinks !== undefined
        ? (nodesNoLinks.filter((node: any) => node.type !== undefined) as NodeResultItem[])
        : [];

    _edges = generateEdges(filteredLinks, validNodes);

    setLinks(filteredLinks);
    setNodes(validNodes);
    setEdges(_edges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRelationships, relationship]);

  useEffect(() => {
    const pluginVPDataStore =
      pluginDataStore.presets[appActiveState.activePresetIdx].customSettings?.vp;
    if (pluginVPDataStore === undefined) {
      reactFlow.fitView();
    } else {
      reactFlow.setViewport(pluginVPDataStore);
    }
    setPluginVPDataStore(pluginVPDataStore);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appActiveState.activePresetId]);

  useEffect(() => {
    const allTablesNodes = generateNodes(allTables);
    const { isPDSCS, customSettings } = isCustomSettingsFn(
      pluginDataStore,
      allTables,
      appActiveState.activePresetId
    );
    // eslint-disable-next-line
    activeCustomSettings = customSettings;
    if (isPDSCS === false) {
      // if custom settings are not found, we set nodes, links, edges and relationship
      const { links, nodes, edges, relationship } = activeCustomSettings;
      setStates(links, nodes, edges, relationship);
      setPluginDataStoreFn(
        pluginDataStore,
        relationship,
        appActiveState.activePresetId,
        nodes,
        links,
        edges
      );
    }

    // In any case and whenever there is a change in the Tables, we need to check if the nodes and tables are equal
    const storedNodesVsTablesNodes = activeCustomSettings.nodes.length === allTablesNodes.length;

    // If the nodes and tables are equal, we check if the ids and columns are equal
    //else we find which nodes are missing or extra
    const newCustomSettings = storedNodesVsTablesNodes
      ? checkNodesVsTablesIds(activeCustomSettings, allTablesNodes, allTables)
      : checkMissingOrExtraIds(activeCustomSettings, allTablesNodes, allTables);

    const { links, nodes, edges, relationship } = newCustomSettings as PresetCustomSettings;

    setStates(links, nodes, edges, relationship);
    setPluginDataStoreFn(
      pluginDataStore,
      relationship,
      appActiveState.activePresetId,
      nodes,
      links,
      edges
    );
  }, [JSON.stringify(allTables), appActiveState.activePresetId]);

  // This function sets the states of the nodes, links, edges and relationship in the ERD Plugin component
  function setStates(_links: any, _nodes: any, _edges: any, _relationship: RelationshipState) {
    setLinks(_links);
    setNodes(_nodes);
    setEdges(_edges);
    setRelationship(_relationship);
    setPluginDataStoreFn(
      pluginDataStore,
      _relationship,
      appActiveState.activePresetId,
      _nodes,
      _links,
      _edges
    );
  }

  const onNodeDragStart = useCallback(
    (event, node) => {
      // Store the current position of all nodes when dragging starts
      const positions: { [key: string]: { x: number; y: number } } = {};
      nodes.forEach((n) => {
        positions[n.id] = { x: n.position.x, y: n.position.y };
      });
      setPrevNodePositions(positions);
    },
    [nodes]
  );

  const onNodeDrag = useCallback(
    (event, node) => {
      node.data.selected = true;
      if (isNode(node) && links && allTables) {
        // Node position is continuously changing, update node's position in state
        const updatedNodes = nodes.map((n) => {
          if (n.id === node.id) {
            // Update node's position in state
            return {
              ...n,
              position: node.position,
              data: {
                ...n.data,
                position: node.position,
              },
            };
          }
          return n;
        }) as NodeResultItem[];

        setNodes(updatedNodes);

        const nodeDataArray = updatedNodes.map((node) => {
          return { n: node.id, cts: node.position.x };
        });
        setNodesCts(nodeDataArray);

        const updatedEdges = edges.map((e) => {
          const sourceNode = nodeDataArray.find((node) => node.n === e.source);
          const targetNode = nodeDataArray.find((node) => node.n === e.target);

          if (!sourceNode || !targetNode || e.source === e.target) {
            return e;
          }
          const isSourceEarlier = sourceNode.cts + 90 < targetNode.cts;

          return {
            ...e,
            sourceHandle: e.sourceHandle?.replace(
              isSourceEarlier ? '_l-' : '_r-',
              isSourceEarlier ? '_r-' : '_l-'
            ),
            targetHandle: e.targetHandle?.replace(
              isSourceEarlier ? '_r-' : '_l-',
              isSourceEarlier ? '_l-' : '_r-'
            ),
          };
        });
        setEdges(updatedEdges);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, setNodes, prevNodePositions]
  );

  const onNodeDragStop = useCallback(
    (event, node) => {
      const updatedNodes = nodes.map((n) => {
        if (n.id === node.id) {
          // Update node's position in state
          return {
            ...n,

            data: {
              ...n.data,
              selected: false,
            },
          };
        }
        return n;
      }) as NodeResultItem[];

      setNodes(updatedNodes);
      setPluginDataStoreFn(
        pluginDataStore,
        activeRelationships,
        appActiveState.activePresetId,
        updatedNodes,
        links,
        edges
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes]
  );

  // const proOptions = { hideAttribution: true };
  return (
    <>
      <ReactFlow
        key={nodes.length}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        defaultViewport={_pluginVPDataStore}
        fitView={false}
        // proOptions={proOptions}
        onMoveEnd={() => {
          setViewportPluginDataStoreFn(
            pluginDataStore,
            appActiveState.activePresetId,
            viewPortState
          );
        }}
        nodeTypes={nodeTypes}></ReactFlow>
    </>
  );
};

export default PluginTR;
