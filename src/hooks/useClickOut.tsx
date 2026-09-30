import { useEffect, useRef } from 'react';

const useClickOut = (handler: any) => {
  const domNode = useRef<any>();

  useEffect(() => {
    const handleOutsideClick = (event: any) => {
      if (!domNode?.current?.contains(event.target)) {
        handler();
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  });

  return domNode;
};

export default useClickOut;
