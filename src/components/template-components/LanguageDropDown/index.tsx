import React, { useEffect, useState } from 'react';
import styles from '../../../styles/template-styles/Plugin.module.scss';
import { AVAILABLE_LOCALES } from '../../../locale';

const LanguageDropdown: React.FC<any> = (props) => {
  const { lang, updateLanguageAndIntl } = props;
  const [selectedLanguage, setSelectedLanguage] = useState<string>('en');

  useEffect(() => {
    setSelectedLanguage(lang);
  }, [lang]);

  const handleLanguageChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedLang = event.target.value;
    setSelectedLanguage(selectedLang);
    updateLanguageAndIntl(selectedLang);
  };

  return (
    <select
      id="languageDropdown"
      onChange={handleLanguageChange}
      value={selectedLanguage}
      className={styles.plugin_header_select}>
      {Object.keys(AVAILABLE_LOCALES).map((langCode) => (
        <option key={langCode} value={langCode}>
          {langCode}
        </option>
      ))}
    </select>
  );
};

export default LanguageDropdown;
