import { useState, type FormEvent } from "react";

import { useCreateUser } from "./hooks";

export function CreateUserForm(): JSX.Element {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const create = useCreateUser();

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    create.mutate(
      { email, name },
      {
        onSuccess: () => {
          setEmail("");
          setName("");
        },
      }
    );
  };

  return (
    <form onSubmit={onSubmit} className="card">
      <input
        className="input"
        type="email"
        placeholder="email@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <input
        className="input"
        type="text"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <button className="button" type="submit" disabled={create.isPending}>
        {create.isPending ? "Saving…" : "Add user"}
      </button>
      {create.error ? (
        <p style={{ color: "#f87171" }}>{create.error.message}</p>
      ) : null}
    </form>
  );
}
