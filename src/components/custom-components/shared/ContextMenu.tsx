import React, { useState, useRef, useEffect, useCallback } from 'react';
import { BsThreeDots } from 'react-icons/bs';
import intl from 'react-intl-universal';

export interface MenuAction {
  label: string;
  icon?: string;
  color?: string;
  needsConfirm?: boolean;
  disabled?: boolean;
  disabledTooltip?: string;
  onClick: () => void;
  // When true, this entry renders as an <hr> separator. Other fields are ignored.
  divider?: boolean;
}

interface ContextMenuProps {
  onDelete: () => void;
  label: string;
  extraActions?: MenuAction[];
  confirmDelete?: boolean;
  deleteColor?: string;
  deleteDisabled?: boolean;
  deleteDisabledTooltip?: string;
}

const ContextMenu: React.FC<ContextMenuProps> = ({
  onDelete,
  label,
  extraActions,
  confirmDelete = true,
  deleteColor = '#dc3545',
  deleteDisabled = false,
  deleteDisabledTooltip,
}) => {
  const [open, setOpen] = useState(false);
  const [confirmIdx, setConfirmIdx] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) {
      setOpen(false);
      setConfirmIdx(null);
    }
  }, []);

  useEffect(() => {
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, handleClickOutside]);

  // Build items: extra actions first, then delete
  const items: MenuAction[] = [
    ...(extraActions || []),
    {
      label,
      icon: 'dtable-icon-delete',
      color: deleteColor,
      needsConfirm: confirmDelete,
      disabled: deleteDisabled,
      disabledTooltip: deleteDisabledTooltip,
      onClick: onDelete,
    },
  ];

  const handleItemClick = (e: React.MouseEvent, idx: number) => {
    e.stopPropagation();
    const item = items[idx];
    if (item.disabled) return;
    if (item.needsConfirm) {
      if (confirmIdx === idx) {
        setOpen(false);
        setConfirmIdx(null);
        item.onClick();
      } else {
        setConfirmIdx(idx);
      }
    } else {
      setOpen(false);
      setConfirmIdx(null);
      item.onClick();
    }
  };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <BsThreeDots
        style={{ cursor: 'pointer', color: '#999', fontSize: 16 }}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
          setConfirmIdx(null);
        }}
      />
      {open && (
        <ul
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            zIndex: 10,
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: 4,
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
            listStyle: 'none',
            margin: 0,
            padding: '4px 0',
            minWidth: 180,
          }}>
          {items.map((item, idx) => {
            if (item.divider) {
              return (
                <li
                  key={idx}
                  style={{
                    height: 1,
                    backgroundColor: '#e9ecef',
                    margin: '4px 0',
                    pointerEvents: 'none',
                  }}
                />
              );
            }
            const isConfirming = confirmIdx === idx;
            const itemColor = item.color || '#333';
            const isDisabled = !!item.disabled;
            return (
              <li
                key={idx}
                onClick={(e) => handleItemClick(e, idx)}
                onMouseLeave={() => {
                  if (confirmIdx === idx) setConfirmIdx(null);
                }}
                title={isDisabled ? item.disabledTooltip : undefined}
                style={{
                  padding: '6px 12px',
                  cursor: isDisabled ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13,
                  fontWeight: 400,
                  color: isConfirming ? '#fff' : isDisabled ? '#bbb' : itemColor,
                  backgroundColor: isConfirming ? itemColor : 'transparent',
                  opacity: isDisabled ? 0.7 : 1,
                  transition: 'all 0.15s',
                }}
                onMouseEnter={(e) => {
                  if (!isConfirming && !isDisabled)
                    e.currentTarget.style.backgroundColor = '#f8f9fa';
                }}
                onMouseOut={(e) => {
                  if (!isConfirming && !isDisabled)
                    e.currentTarget.style.backgroundColor = 'transparent';
                }}>
                <i
                  className={`dtable-font ${isConfirming ? 'dtable-icon-confirm' : item.icon || 'dtable-icon-delete'}`}
                  style={{ fontSize: 14 }}
                />
                {isConfirming ? intl.get('common.confirm').d('Confirm?') : item.label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default ContextMenu;
