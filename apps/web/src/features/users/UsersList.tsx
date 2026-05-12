import { useDeleteUser, useUsers } from "./hooks";

export function UsersList(): JSX.Element {
  const { data, isLoading, error } = useUsers();
  const deleteUser = useDeleteUser();

  if (isLoading) return <p>Loading…</p>;
  if (error) return <p>Failed to load users.</p>;
  if (!data || data.length === 0) return <p>No users yet.</p>;

  return (
    <ul style={{ listStyle: "none", padding: 0 }}>
      {data.map((user) => (
        <li key={user.id} className="card">
          <div>
            <strong>{user.name}</strong> — {user.email}
          </div>
          <button
            type="button"
            className="button"
            disabled={deleteUser.isPending}
            onClick={() => deleteUser.mutate(user.id)}
          >
            Delete
          </button>
        </li>
      ))}
    </ul>
  );
}
