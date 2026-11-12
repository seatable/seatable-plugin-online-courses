import { ICourseEntry } from './Presets.interface';

export interface IPresetItemProps {
  p: ICourseEntry;
  active: boolean;
  onSelectPreset: (courseId: string) => void;
}
