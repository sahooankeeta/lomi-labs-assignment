import { useParams } from 'react-router';

export function DocumentDetail() {
  const { id } = useParams();
  return (
    <section>
      <h1>{id}</h1>
      <p>Extracted values beside their source quotes, with approve / correct, go here.</p>
    </section>
  );
}
