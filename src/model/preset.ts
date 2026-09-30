import { IPresetModel } from '../utils/template-interfaces/Model.interface';

export default class Preset {
  _id: string;
  name: string;
  settings: any;
  customSettings: any;

  constructor(object: IPresetModel) {
    this._id = object._id;
    this.name = object.name;
    this.settings = object.settings;
    this.customSettings = object.customSettings;
  }
}
