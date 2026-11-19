import { useEffect, useState } from 'react';

const apiUrl = import.meta.env.VITE_API_URL || '';

async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...options.headers,
    },
  });

  if (response.status === 204) return null;

  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [tasks, setTasks] = useState([]);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskInput, setTaskInput] = useState('');
  const [operation, setOperation] = useState('uppercase');
  const [taskError, setTaskError] = useState('');
  const [taskBusy, setTaskBusy] = useState(false);

  useEffect(() => {
    let active = true;

    request('/api/auth/me')
      .then(({ user: currentUser }) => {
        if (active) setUser(currentUser);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setCheckingSession(false);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!user) return undefined;

    let active = true;
    async function loadTasks() {
      try {
        const { tasks: currentTasks } = await request('/api/tasks?limit=100');
        if (active) setTasks(currentTasks);
      } catch {
        if (active) setTasks([]);
      }
    }

    loadTasks();
    const interval = window.setInterval(loadTasks, 3000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [user]);

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);

    try {
      const { user: authenticatedUser } = await request(`/api/auth/${mode === 'register' ? 'register' : 'login'}`, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setUser(authenticatedUser);
      setPassword('');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await request('/api/auth/logout', { method: 'POST', body: '{}' });
    setUser(null);
    setMode('login');
  }

  async function handleCreateTask(event) {
    event.preventDefault();
    setTaskError('');
    setTaskBusy(true);

    try {
      const { task } = await request('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ title: taskTitle, input: taskInput, operation }),
      });
      setTasks((current) => [task, ...current.filter((item) => item._id !== task._id)]);
      setTaskTitle('');
      setTaskInput('');
    } catch (requestError) {
      setTaskError(requestError.message);
    } finally {
      setTaskBusy(false);
    }
  }

  if (checkingSession) {
    return <main className="session-check" aria-label="Checking session" />;
  }

  if (user) {
    return (
      <main className="app-shell">
        <header className="topbar">
          <a className="wordmark" href="/" aria-label="Taskroom home">
            <span className="wordmark-mark">T</span> taskroom
          </a>
          <button className="text-button" onClick={handleLogout} type="button">Sign out</button>
        </header>

        <div className="dashboard">
          <section className="task-composer" aria-labelledby="composer-title">
            <p className="eyebrow">NEW TASK</p>
            <h1 id="composer-title">Create an input task</h1>
            <form onSubmit={handleCreateTask}>
              <label htmlFor="task-title">Title</label>
              <input
                id="task-title"
                maxLength={120}
                onChange={(event) => setTaskTitle(event.target.value)}
                placeholder="Example: Format customer text"
                required
                value={taskTitle}
              />

              <label htmlFor="task-input">Text input</label>
              <textarea
                id="task-input"
                maxLength={50000}
                onChange={(event) => setTaskInput(event.target.value)}
                placeholder="Enter the text to process"
                required
                value={taskInput}
              />

              <label htmlFor="operation">Operation</label>
              <select
                id="operation"
                onChange={(event) => setOperation(event.target.value)}
                value={operation}
              >
                <option value="uppercase">UPPERCASE</option>
                <option value="lowercase">LOWERCASE</option>
                <option value="reverse">REVERSE</option>
                <option value="word_count">WORD COUNT</option>
              </select>

              {taskError && <p className="form-error" role="alert">{taskError}</p>}

              <button className="submit-button" disabled={taskBusy} type="submit">
                {taskBusy ? 'Submitting...' : 'Submit task'}
                <span aria-hidden="true">↗</span>
              </button>
            </form>
          </section>

          <section className="task-list-panel" aria-labelledby="tasks-title">
            <div className="task-list-heading">
              <div>
                <p className="eyebrow">WORKSPACE</p>
                <h2 id="tasks-title">My tasks</h2>
              </div>
              <span className="task-count">{tasks.length}</span>
            </div>

            {tasks.length === 0 ? (
              <div className="empty-task-list">
                <span className="status-dot" />
                <p>No tasks yet. Submit one using the form.</p>
              </div>
            ) : (
              <div className="task-list">
                {tasks.map((task) => (
                  <article className="task-card" key={task._id}>
                    <div className="task-card-heading">
                      <h3>{task.title}</h3>
                      <span className={`task-status status-${task.status}`}>{task.status === 'pending' ? 'waiting' : task.status}</span>
                    </div>
                    <p className="task-operation">{task.operation.replace('_', ' ')}</p>
                    <p className="task-input-preview">{task.input}</p>
                    {task.status === 'success' && (
                      <div className="task-result">
                        <span>Result</span>
                        <strong>{typeof task.result === 'string' ? task.result : JSON.stringify(task.result)}</strong>
                      </div>
                    )}
                    {task.status === 'failed' && task.processingLogs?.length > 0 && (
                      <p className="task-failed">{task.processingLogs.at(-1).message}</p>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-layout">
      <section className="brand-panel" aria-label="Taskroom">
        <a className="wordmark" href="/">
          <span className="wordmark-mark">T</span> taskroom
        </a>
        <div className="brand-copy">
          <p className="eyebrow">AI TASK PLATFORM</p>
          <h1>Small inputs.<br />Useful outcomes.</h1>
          <p className="brand-description">A clear place to submit text tasks and follow every step from queue to result.</p>
        </div>
        <div className="workflow-strip" aria-label="Task workflow">
          <span><i>01</i> Submit</span>
          <b aria-hidden="true">/</b>
          <span><i>02</i> Process</span>
          <b aria-hidden="true">/</b>
          <span><i>03</i> Review</span>
        </div>
        <div className="panel-index">PLATFORM ACCESS <span>01 / 04</span></div>
      </section>

      <section className="form-panel" aria-labelledby="form-title">
        <div className="form-wrap">
          <div className="mobile-wordmark wordmark">
            <span className="wordmark-mark">T</span> taskroom
          </div>
          <p className="eyebrow form-eyebrow">{mode === 'register' ? 'NEW ACCOUNT' : 'WELCOME BACK'}</p>
          <h2 id="form-title">{mode === 'register' ? 'Create your account' : 'Sign in to continue'}</h2>
          <p className="form-intro">
            {mode === 'register' ? 'Set up your workspace access.' : 'Your task workspace is one step away.'}
          </p>

          <form onSubmit={handleSubmit}>
            <label htmlFor="email">Email address</label>
            <input
              autoComplete="email"
              id="email"
              maxLength={254}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              required
              type="email"
              value={email}
            />

            <label htmlFor="password">Password</label>
            <input
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              id="password"
              minLength={mode === 'register' ? 12 : undefined}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={mode === 'register' ? 'At least 12 characters' : 'Enter your password'}
              required
              type="password"
              value={password}
            />
            {mode === 'register' && <p className="field-hint">Use 12 or more characters.</p>}

            {error && <p className="form-error" role="alert">{error}</p>}

            <button className="submit-button" disabled={busy} type="submit">
              {busy ? 'Please wait...' : mode === 'register' ? 'Create account' : 'Sign in'}
              <span aria-hidden="true">↗</span>
            </button>
          </form>

          <p className="switch-mode">
            {mode === 'register' ? 'Already have an account?' : 'New to taskroom?'}{' '}
            <button
              onClick={() => {
                setMode(mode === 'register' ? 'login' : 'register');
                setError('');
              }}
              type="button"
            >
              {mode === 'register' ? 'Sign in' : 'Create account'}
            </button>
          </p>
          <p className="security-note"><span aria-hidden="true">●</span> Secure, private workspace access</p>
        </div>
      </section>
    </main>
  );
}