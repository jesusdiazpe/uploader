import "./src/style.css";

// Local: tu backend corre en 3001
// En Render: lo pondrás con un env var VITE_API_BASE
const API = import.meta.env.VITE_API_BASE || "http://localhost:3001";

const fileInput = document.querySelector("#file");
const uploadBtn = document.querySelector("#upload");
const out = document.querySelector("#out");

uploadBtn.onclick = async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  out.textContent = "Subiendo...";

  const form = new FormData();
  form.append("image", file);

  const res = await fetch(`${API}/upload`, { method: "POST", body: form });
  const data = await res.json();

  if (!res.ok) {
    out.textContent = data?.error || "Error";
    return;
  }

  out.innerHTML = `
    <p><b>Link para ver:</b> <a target="_blank" href="${data.viewUrl}">${data.viewUrl}</a></p>
    <p><b>Eliminar imagen:</b> <button id="delete-image" type="button">Eliminar</button></p>
    <p style="opacity:.7;font-size:13px">Solo existe 1 imagen activa. Si subes otra, se reemplaza.</p>
  `;

  const deleteBtn = document.querySelector("#delete-image");
  deleteBtn?.addEventListener("click", async () => {
    deleteBtn.disabled = true;
    deleteBtn.textContent = "Eliminando...";

    try {
      const deleteRes = await fetch(data.deleteUrl, { method: "GET" });

      if (!deleteRes.ok) {
        out.textContent = "No se pudo eliminar la imagen.";
        return;
      }

      out.textContent = "Imagen eliminada.";
      fileInput.value = "";
    } catch {
      out.textContent = "No se pudo eliminar la imagen.";
    }
  });
};
