import { useEffect, useSyncExternalStore } from 'react';
import { mealCreationStore } from '../../utils/mealCreationStore';

export default function useMealCreationState() {
  const snapshot = useSyncExternalStore(mealCreationStore.subscribe, mealCreationStore.getSnapshot);
  useEffect(() => { mealCreationStore.load().catch(() => {}); }, []);
  return snapshot;
}
