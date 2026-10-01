import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export interface Hero {
  id: string;
  name: string;
}

export function heroFromSession(session: Session): Hero {
  const meta = session.user.user_metadata as { username?: string };
  const fallback = session.user.email?.split("@")[0] ?? "Hero";
  return { id: session.user.id, name: (meta.username || fallback).slice(0, 16) };
}

/** Wires up the sign-in / create-account form. Calls onSignedIn once a session exists. */
export function setupAuthScreen(onSignedIn: (session: Session) => void) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const form = $<HTMLFormElement>("auth-form");
  const tabLogin = $<HTMLButtonElement>("tab-login");
  const tabSignup = $<HTMLButtonElement>("tab-signup");
  const usernameField = $<HTMLLabelElement>("username-field");
  const username = $<HTMLInputElement>("auth-username");
  const email = $<HTMLInputElement>("auth-email");
  const password = $<HTMLInputElement>("auth-password");
  const submit = $<HTMLButtonElement>("auth-submit");
  const message = $<HTMLParagraphElement>("auth-message");

  let mode: "login" | "signup" = "login";

  const setMode = (next: typeof mode) => {
    mode = next;
    tabLogin.classList.toggle("active", mode === "login");
    tabSignup.classList.toggle("active", mode === "signup");
    usernameField.hidden = mode === "login";
    username.required = mode === "signup";
    password.autocomplete = mode === "login" ? "current-password" : "new-password";
    submit.textContent = mode === "login" ? "Sign in" : "Create account";
    showMessage("");
  };

  const showMessage = (text: string, ok = false) => {
    message.textContent = text;
    message.classList.toggle("ok", ok);
  };

  tabLogin.onclick = () => setMode("login");
  tabSignup.onclick = () => setMode("signup");

  form.onsubmit = async (e) => {
    e.preventDefault();
    submit.disabled = true;
    showMessage("");
    try {
      if (mode === "signup") {
        const name = username.value.trim();
        if (!/^[\w-]{3,16}$/.test(name)) {
          showMessage("Hero name: 3–16 letters, numbers, _ or -");
          return;
        }
        const { data, error } = await supabase.auth.signUp({
          email: email.value.trim(),
          password: password.value,
          options: { data: { username: name } },
        });
        if (error) return showMessage(error.message);
        if (data.session) onSignedIn(data.session);
        else showMessage("Account created. Check your email to confirm, then sign in.", true);
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: email.value.trim(),
          password: password.value,
        });
        if (error) return showMessage(error.message);
        onSignedIn(data.session);
      }
    } finally {
      submit.disabled = false;
    }
  };
}
