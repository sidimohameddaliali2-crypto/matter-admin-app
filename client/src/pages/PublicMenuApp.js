import React from 'react';
import MenuSelectionLink from '../components/menuSelectionLink/MenuSelectionLink';

export default function PublicMenuApp() {
  const token = decodeURIComponent(window.location.pathname.split('/')[2]);
  return <MenuSelectionLink token={token} />;
}
