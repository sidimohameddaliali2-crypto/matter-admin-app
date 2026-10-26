export const normalizeBagLabel=value=>String(value||'').trim().toUpperCase().replace(/^BAG_/,'BAG-');

export function matchingBagLabels(bags,value){
  const code=normalizeBagLabel(value);
  return bags.filter(b=>normalizeBagLabel(b.bagId)===code);
}
