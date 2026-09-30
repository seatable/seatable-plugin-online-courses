// Table
export interface Table {
  _id: string;
  name: string;
  rows: TableRow[];
  columns: TableColumn[];
  view_structure: {
    folders: any[]; // AnyToFix
    view_ids: string[];
  };
  views: TableView[];
  id_row_map: Record<string, TableRow>;
}

export interface TableColumn {
  key: string;
  name: string;
  type: string;
  width: number;
  editable: boolean;
  resizable: boolean;
  draggable: boolean;
  data: any; // AnyToFix
  permission_type: string;
  permitted_users: string[];
  permitted_group: string;
  edit_metadata_permission_type: string;
  edit_metadata_permitted_users: string[];
  edit_metadata_permitted_group: string;
  description: string | null;
}

export interface TableRow {
  _id: string;
  _participants: any[]; // AnyToFix
  _creator: string;
  _ctime: string;
  _last_modifier: string;
  _mtime: string;
  [key: string]: string | number | any[]; // AnyToFix
}

// Table View
export interface TableView {
  _id: string;
  name: string;
  type: string;
  is_locked: boolean;
  private_for?: string | null;
  row_height: string;
  filter_conjunction: string;
  filters: Filter[];
  sorts: any[]; // AnyToFix
  groupbys: GroupBy[];
  colorbys?: Record<string, any>; // AnyToFix
  hidden_columns: string[];
  rows: TableRow[];
  formula_rows: Record<string, any>; // AnyToFix
  link_rows: Record<string, any>; // AnyToFix
  summaries: Record<string, any>; // AnyToFix
  colors: Record<string, any>; // AnyToFix
  column_colors: Record<string, any>; // AnyToFix
  groups: any[]; // AnyToFix
}

interface Filter {
  column_key: string;
  filter_predicate: string;
  filter_term: string;
}

interface GroupBy {
  column_key: string;
  sort_type: string;
  count_type: string;
}

export interface IActiveTableAndView {
  table: Table;
  view: TableView;
}

export type TableViewArray = TableView[];
export type TableArray = Table[];
