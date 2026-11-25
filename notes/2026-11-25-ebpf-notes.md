# ebpf-notes

What is eBPF, where can it attach, and how does it talk to userspace?

eBPF is used for running code inside the kernel, like any other kernel code. It originated as just a packet filter (BPF is Berkeley Packet Filter), and now it is very mature, and a separate subsystem in the kernel. It is used for observing the kernel, filtering packets, forwarding them, dropping them, etc.

We can see which functions are called, and we can trace a request through the kernel, by attaching the program in different places. These places are called hooks. Like a function start, function end, or upon receiving a packet. ALMOST any event happening in the kernel can be observed by eBPF programs. And we can load and unload a program with ease, without rebooting the kernel, and without changing the kernel's source code.

## How a program gets into the kernel

1. We write the program in C (a restricted version of it).
2. Then compile it with `clang`. This gives an object file, which contains bytecode. The eBPF subsystem is like a virtual machine inside the kernel, and this bytecode is its instruction set.
3. Then load the object file into the kernel, using the `bpf()` system call, or a library like libbpf which does it for us.
4. The verifier checks the program. The program is loaded only when the verifier passes it.
5. The bytecode is compiled to machine code. This is JIT compilation, just in time. It happens once, at load time. So when a packet arrives, the kernel is not interpreting bytecode one by one, it is running machine code.
6. And then we attach the program to a hook.

Loading and attaching are two separate steps. Once a program is loaded, we can be sure that it is verified. But it does not run until we attach it to a hook. Once attached, it runs every time that event happens.

## What a program gets

Every program has a type, like tc(traffic control), socket filter, or kprobe. The type decides three things:

- **Where it can attach.** A tc program goes on the network path, a kprobe program goes on a kernel function.
- **What it is given.** When the hook is hit, the program gets a pointer to a context. The program can only read the fields its type allows.
- **Which helpers it can call.** The program cannot call just any kernel function, because they change between kernel versions. Instead, it calls helpers, which are a stable set of functions the kernel offers. Like getting the time, reading a map, or changing a packet.

If a kprobe program calls a helper which is only for network programs, it compiles without errors, because `clang` does not know about this rule. It fails at load time. The verifier knows the type of the program, so it rejects it.

## The verifier

Our code runs in the kernel, meaning, if one small thing goes wrong, the whole system may have to be rebooted. So the kernel has a verifier, which makes sure that our program only accesses proper memory addresses, and has no infinite loops or anything.

It does not run the program. It goes through every possible path, and keeps track of what each register could hold. The program is rejected, if in any of these paths, it cannot be sure about something.

### NULL checks

When we look up a key in a map, we get a pointer to the value, or NULL. We have to check for NULL before using it. The verifier rejects the program without this check. It never looks inside the map. It only looks at the code and the types. And someone could delete that key a second later anyway.

### Bounds checks

For a tc program, the context contains some numbers, which should be casted to pointers before using them. These are `data`, the start of the packet, and `data_end`, the end of the packet. Before reading anything, we have to check that what we read ends before `data_end`:

```c
struct ethhdr *eth = data;
if ((void *)(eth + 1) > data_end)
    return TC_ACT_OK;
```

This check only covers the ethernet header. We need one for the IP header as well, and one for the UDP header.

### Loops

Loops are allowed, if they are clearly bounded. `for (int i = 0; i < 100; i++)` is accepted. A loop which ends only when some value in a map becomes 0 might run indefinitely, so it is not accepted.

There is also a limit of 1 million instructions. This is not the length of the program, it is how many instructions the verifier goes through while checking all the paths. So a short program with a lot of branches can also hit it.

## Where it can attach

There are literally so many places in the kernel we can attach the program, it is very hard to keep track of them. These are the ones we care about mostly.

- **tc ingress.** It runs after the skb is built, and before IP/UDP. Since we have the skb, we can figure out the port, and pass, drop, change or redirect the packet. There is tc egress as well, for packets going out.
- **Socket filter.** It is attached to one socket. It decides whether a packet gets into that socket's receive queue.
- **cgroup.** A cgroup is a group of processes, like a container. The program applies to everything in that group. For example, we can make sure that only the processes in one container cannot connect to a certain IP.
- **kprobe.** It can be attached to almost any kernel function, by its name. It is very flexible, but if the function does not exist in another kernel, then it simply won't work there.
- **tracepoint.** Hooks which the kernel developers placed on purpose, with defined arguments. There are fewer of them. If nothing is attached to it, it costs almost nothing.

XDP is also just a place/hook where we can attach a program.

## Maps

Data can be shared between the user program and the kernel. Once the program is loaded in the kernel, it can write data to a data structure which is shared with our user program. These are called maps. There are many of them, arrays, hashmaps, per cpu arrays, stacks, queues, ring buffers, bloom filters etc.

| map                  | what it is                                                        |
| -------------------- | ----------------------------------------------------------------- |
| array                | fixed size, all slots are allocated up front, cannot delete       |
| hash                 | key to value, up to the max entries we give                       |
| LRU hash             | a hash which evicts the least recently used entry when it is full |
| per cpu array / hash | each core has its own copy of the value                           |

The eBPF program accesses the map using helpers. The user program usually accesses it using the `bpf()` system call, one for each lookup or update. The whole thing is not memory mapped for every map. An array can be memory mapped if we ask for it (`BPF_F_MMAPABLE`), and so can the data of a ring buffer. For these, we can read without a system call every time.

### An example

Let's say we want to count packets per source IP, at a very high rate, on 8 cores, and there may be more IPs than we have room for. So, we would use an LRU per cpu hash.

LRU, because there may be more than what we have room for, so we need to evict some things. Per cpu, because if the value is shared among all 8 cores, there will be contention and cross-core coordination. So each core has its own value, and the user program sums them up. But if an IP is evicted, its count is lost.

### Reloading the program

This one is important. Assume we have a reader who reads from a map, and our eBPF program in the kernel is the writer. The reader has a file descriptor (fd) for this map. As long as there is a reference to this map, the kernel will not deallocate it. It kind of works like a `std::shared_ptr<>`.

So, assume that as this reader is reading, we reload the program. Instead of reusing the already created map, this creates a new map, and the program writes there. But the reader still reads from the old map, so the reader's data is stale.

**Pinning**

Pinning gives the map a path in `/sys/fs/bpf`. The map stays alive even if our loader exits, and other processes can open it using this path.

But pinning alone is not enough. When we reload the program, the pinned map is not reused just because it is there. If we don't reuse it, a new map is created, and the data starts from zero again.

**Reusing the map**

We have to tell libbpf to use the pinned map, instead of creating a new one. This has to be done after open, and before load, because load is where the maps are created.

```c
// read the new program's object file. nothing is in the kernel yet
obj = bpf_object__open_file("prog.o", NULL);

// find "my_map" inside the new program. this map is not created yet
map = bpf_object__find_map_by_name(obj, "my_map");

// get the fd of the old map, which is already in the kernel
fd = bpf_obj_get("/sys/fs/bpf/my_map");

// if it exists, tell libbpf: for "my_map", use this old map, don't create a new one
if (fd >= 0)
    bpf_map__reuse_fd(map, fd);

// now load. the new program uses the old map
bpf_object__load(obj);
```

The first time, there is no pinned map, so it creates a new one, and we pin it after load.

The other way is to set `LIBBPF_PIN_BY_NAME` in the map's definition. Then libbpf does this for us. At load time, if the map is already pinned, it reuses it, otherwise it creates and pins it.

**If the map does not match**

Assume the new program's map has a different type, key size, value size, or max entries than the pinned one.

- With `LIBBPF_PIN_BY_NAME`, libbpf compares them, and the load fails.
- With `bpf_map__reuse_fd()`, there is no check. It simply takes the definition of the pinned map. If our new struct is bigger than the old value size, the verifier should reject the program (i think). If it fits, the program may load, and read the wrong data.

And if the struct has the same size, but different fields, neither of them notices. The map only knows the size of the value, not what is inside. So the user program and the eBPF program have to keep the struct in sync.

**The reader**

- If the reader is in the same process as the loader, it reads through the bpf object. It finds the map with `bpf_object__find_map_by_name()`, and gets the fd with `bpf_map__fd()`. The bpf object is a libbpf struct in the process which loaded the program, and each load makes a new object. So after a reload, it has to use the new object.
- If the reader is another process, it knows nothing about that object. So it opens the pinned path with `bpf_obj_get()`.

If the loader reuses the map, the reader's fd is still good, because it is the same map. If it does not, the reader has to open the pinned path again, and check the map's ID. If the ID has changed, it is a new map.

## Ring buffer

A ring buffer is a map for sending events to user space. Others hold the latest state, while this one is a stream of records.

There is one buffer shared by all the cores, so the order of events is preserved across cores. Writing happens in two steps:

1. `bpf_ringbuf_reserve()` reserves the space in the buffer.
2. We fill it in place, and then publish it with `bpf_ringbuf_submit()`, or throw it away with `bpf_ringbuf_discard()`.

There is also `bpf_ringbuf_output()`, which does it in one step, but with an extra copy.

The records become readable in the order they were reserved. If core 1 reserves first, and takes some time to fill it, and core 2 reserves after it and publishes immediately, the user program cannot see core 2's record. Unless core 1 publishes (or discards) its record, core 2's record has to wait.

The user program can sleep until there is new data (`epoll`), or keep polling for the lowest latency. The kernel only wakes it up if it has already caught up with everything before this record.

If the user program is too slow, the buffer fills up, and it simply fails to add. It does not wait. So if I need to know how many events I lost, I have to count the failures myself, in a map.

## libbpf

libbpf is a C library which loads the object file and manages all this for us. The program goes through four phases:

1. **Open.** It reads the object file and finds the programs, maps, and global variables. Nothing is in the kernel yet. So this is where I set the starting value of a global variable.
2. **Load.** It creates the required maps, and the kernel verifies the programs, and it fails if necessary.
3. **Attach.** The programs are attached to the hooks and start running.
4. **Tear down.** The programs are detached and unloaded, and the maps are freed, unless something else still holds them.

Before attaching, I can populate the maps initially, as the maps are created by this stage. If I do this after attaching, some events may come in while the map is still empty.

`bpftool` can also generate a skeleton, a header file with the bytecode inside it. Then I can just call `<name>__open()`, `<name>__load()`, `<name>__attach()` and `<name>__destroy()`.

### Running on a different kernel

The kernel's structs change between versions, so a field can move to a different offset. CO-RE (compile once, run everywhere) handles this. The kernel describes its own types in a format called BTF, in `/sys/kernel/btf/vmlinux`. At load time, libbpf compares the types my program was compiled with, to the types of the running kernel, and fixes the offsets.

So, if this program is run on a different kernel, almost all of the time it works as expected. Unless I hardcode the offsets, or I use an explicit function name for a kprobe and that function does not exist in that kernel.

## Putting it together

We want to drop UDP packets to port 9999, and our user program should print the source IP of each dropped packet.

1. We write the C code, which checks the port, and if it matches 9999, it writes the source IP to a ring buffer, and drops the packet.
2. We compile it to an object file.
3. And then load it. The maps are created, the verifier checks the program, and it is compiled to machine code.
4. Now, we attach it to tc ingress.
5. When a packet arrives, the program is given a context. It does the bounds checks, and reads the port.
6. Our user program reads the IPs from the ring buffer, and prints them in order.
7. If our user program is too slow, adding to the ring buffer fails, and the program counts it. The packet is still dropped.

## Sources

- [ebpf.io: what is eBPF](https://ebpf.io/what-is-ebpf/)
- [kernel docs: BPF](https://docs.kernel.org/bpf/index.html)
- [ebpf and xdp](https://github.com/xdp-project/xdp-tutorial)
