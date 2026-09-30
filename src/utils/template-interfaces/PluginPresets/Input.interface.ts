export interface IPresetInput {
  onChangePresetName: (e: React.FormEvent<HTMLInputElement>) => void;
  setIsEditing: React.Dispatch<React.SetStateAction<boolean>>;
  isEditing: boolean;
  presetName: string;
}
