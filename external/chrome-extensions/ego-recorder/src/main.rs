mod classify;
mod compile;
mod derive;
mod flow;
mod host;
mod install;
mod keychain;
mod provenance;
mod runner;
mod scrub;
mod store;
mod view;
mod wire;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use keychain::{Keychain, Vault};
use std::collections::BTreeMap;
use std::path::PathBuf;
use store::Store;

/// Record a browser session in ego lite and build a replayable automation from it.
#[derive(Parser)]
#[command(name = "ego-rec", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// List recordings, newest first
    List,
    /// Print the prompt that the extension's copy button copies
    Prompt { id: String },
    /// Print a recording as compact text
    Show {
        id: String,
        /// Detail for one step
        #[arg(long)]
        step: Option<u32>,
        /// API calls with shapes and dependencies, limited to --step when given
        #[arg(long)]
        net: bool,
        /// Print the path of the screenshot taken at this step
        #[arg(long)]
        shot: Option<u32>,
    },
    /// Generate a runnable script
    Compile {
        id: String,
        #[arg(short)]
        output: PathBuf,
    },
    /// Run a script up to, and not including, its payment step. Never charges
    Test {
        file: PathBuf,
        #[arg(long = "param", value_name = "K=V")]
        params: Vec<String>,
    },
    /// Run a script for real, including the payment
    Run {
        file: PathBuf,
        #[arg(long = "param", value_name = "K=V")]
        params: Vec<String>,
        /// Run even though the last run's outcome is unknown
        #[arg(long)]
        again: bool,
    },
    /// Check or read a recording's input values
    Input {
        #[command(subcommand)]
        command: InputCommand,
    },
    /// Register the native messaging host for the extension
    Install {
        #[arg(long)]
        dry_run: bool,
    },
    /// Delete a recording and the saved values only it uses
    Rm { id: String },
}

#[derive(Subcommand)]
enum InputCommand {
    /// Print a JSON array of the keys that have no value yet
    Missing { rec: String, keys: Vec<String> },
    /// Print a JSON object of values. Once-only values are consumed
    Get { rec: String, keys: Vec<String> },
}

fn main() {
    // Browsers launch a native host with its origin as the first argument.
    if std::env::args()
        .nth(1)
        .is_some_and(|arg| arg.starts_with("chrome-extension://"))
    {
        if let Err(error) = run_host() {
            eprintln!("ego-rec host: {error:#}");
            std::process::exit(1);
        }
        return;
    }
    match run_cli(Cli::parse()) {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("ego-rec: {error:#}");
            std::process::exit(1);
        }
    }
}

fn run_host() -> Result<()> {
    host::serve(
        &Store::open()?,
        &Keychain::from_env(),
        std::io::stdin().lock(),
        std::io::stdout().lock(),
    )
}

fn run_cli(cli: Cli) -> Result<i32> {
    let store = Store::open()?;
    let vault = Keychain::from_env();
    match cli.command {
        Command::List => print!("{}", view::list_text(&store, &vault)?),
        Command::Prompt { id } => print!("{}", view::prompt(&store.meta(&id)?)),
        Command::Show {
            id,
            step,
            net,
            shot,
        } => {
            let flow = store.flow(&id)?;
            match (shot, step, net) {
                (Some(n), _, _) => println!("{}", view::shot_path(&store, &flow, n)?.display()),
                (None, step, true) => print!("{}", view::show_net(&flow, step)),
                (None, Some(n), false) => print!("{}", view::show_step(&flow, n)?),
                (None, None, false) => print!("{}", view::show_flow(&flow)),
            }
        }
        Command::Compile { id, output } => {
            runner::compile_to(&store, &id, &output)?;
            println!("{}", output.display());
        }
        Command::Test { file, params } => {
            return runner::execute(&store, &vault, &file, &params, true);
        }
        Command::Run {
            file,
            params,
            again,
        } => return runner::run(&store, &vault, &file, &params, again),
        Command::Input { command } => print!("{}", input_command(&store, &vault, command)?),
        Command::Install { dry_run } => {
            let home = PathBuf::from(std::env::var_os("HOME").context("HOME is not set")?);
            print!(
                "{}",
                install::install(&home, &std::env::current_exe()?, dry_run)?
            );
        }
        Command::Rm { id } => view::delete(&store, &vault, &id)?,
    }
    Ok(0)
}

fn input_command(store: &Store, vault: &dyn Vault, command: InputCommand) -> Result<String> {
    match command {
        InputCommand::Missing { rec, keys } => {
            let flow = store.flow(&rec)?;
            let fields = view::input_fields(&flow, vault)?;
            let missing: Vec<&str> = keys
                .iter()
                .map(String::as_str)
                .filter(|key| !fields.iter().any(|f| f.key == *key && f.present))
                .collect();
            Ok(serde_json::to_string(&missing)?)
        }
        InputCommand::Get { rec, keys } => {
            let flow = store.flow(&rec)?;
            let mut values = BTreeMap::new();
            for key in keys {
                if let Some(value) = keychain::take(vault, &flow.scope, &key)? {
                    values.insert(key, value);
                }
            }
            Ok(serde_json::to_string(&values)?)
        }
    }
}
