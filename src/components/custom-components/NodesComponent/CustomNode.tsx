import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { CellType, COLUMNS_ICON_CONFIG } from 'dtable-utils';
import stylesCustom from '../../../styles/custom-styles/PluginTR.module.scss';
import { LINK_TYPE } from '../../../utils/custom-constants/constants';

function getIconByType(ct: any, t: any) {
  const C_T = Object.keys(ct).find((key) => ct[key] === t);
  const i = COLUMNS_ICON_CONFIG[CellType[C_T as string] as keyof typeof COLUMNS_ICON_CONFIG];
  return i;
}

function CustomNode({ id, data }: { id: string; data: any }) {
  return (
    <>
      <div className={stylesCustom.custom_node_header}>
        <strong>{data.name}</strong>
      </div>
      <div className={stylesCustom.custom_node_body}>
        {data.columns.map((cl: any) => (
          <div key={cl.key} id={cl.key} className={stylesCustom.custom_node_row}>
            <Handle
              type="source"
              position={Position.Left}
              style={{ left: '-10px', visibility: 'hidden' }}
              id={id + '_' + cl.key + '_l-src'}
            />
            <Handle
              type="target"
              position={Position.Right}
              style={{ right: '-10px', visibility: 'hidden' }}
              id={id + '_' + cl.key + '_r-tgt'}
            />
            <Handle
              type="target"
              position={Position.Left}
              style={{ left: '-10px', visibility: 'hidden' }}
              id={id + '_' + cl.key + '_l-tgt'}
            />
            <Handle
              type="source"
              position={Position.Right}
              style={{ right: '-10px', visibility: 'hidden' }}
              id={id + '_' + cl.key + '_r-src'}
            />
            <div className={stylesCustom.custom_node_row_content}>
              <div className={stylesCustom.custom_node_row_content_icon}>
                <i
                  className={`dtable-font ${getIconByType(CellType, cl.type)}`}
                  style={{ fontSize: '10px' }}></i>
              </div>
              <div className={stylesCustom.custom_node_row_content_value}>{cl.name}</div>
              <div className={stylesCustom.custom_node_row_content_ref}>
                {cl.type === LINK_TYPE.link ? (cl.isMultiple ? '[n]' : '[1]') : ''}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export default memo(CustomNode);
