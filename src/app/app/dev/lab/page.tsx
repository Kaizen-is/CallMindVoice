import { redirect } from 'next/navigation';

/** The Model lab moved to Models ▸ Model lab; old links and open tabs land there. */
export default function OldModelLabPage() {
  redirect('/app/models/lab');
}
