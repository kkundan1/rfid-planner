import { redirect } from 'next/navigation';
import { currentUser, needsSetup, ownerId, userName } from '@/lib/auth';
import PlannerClient from '@/components/PlannerClient';

export const dynamic = 'force-dynamic';

export default function Home() {
  if (needsSetup()) redirect('/login');
  const u = currentUser();
  if (!u) redirect('/login');
  const me = { id: u.id, name: userName(u.id), isOwner: u.id === ownerId(), canEdit: u.role === 'admin', role: u.role };
  return <PlannerClient me={me} />;
}
